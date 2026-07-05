// OTel: debe ir PRIMERO, antes de cualquier import instrumentable (http/fastify/pino).
import "./instrumentation";
import * as Sentry from "@sentry/node";
import fastify, {
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import path from "path";
import dotenv from "dotenv";
import { scrapePerfumePage } from "./scraper";
import { PerfumeSchema, Perfume } from "./schema";
import {
  createSession,
  getSession,
  updateSessionConfirmation,
  deleteSession,
} from "./session-store";
import { validateAndOptimizeImageData, processAndUploadImage } from "./image-processor";
import { authMiddleware, isValidToken, registerToken } from "./auth";
import {
  callerEnvFromHeader,
  callerEnvStore,
  recordScraperRequest,
  timeProviderCall,
} from "./metrics";
import { tavily } from "@tavily/core";
import { syncPrices } from "./sync";

dotenv.config();

// ── API Test Push ──────────────────────────────────────────────────────────
// Register token from env after dotenv is configured
if (process.env.SCRAPER_API_TOKEN) {
  registerToken(process.env.SCRAPER_API_TOKEN, "default");
}

const server = fastify({ logger: true });

// Fija el caller_env (header x-aura-env) en AsyncLocalStorage por la vida del
// request, para que las métricas de proveedor (disparadas en scraper.ts) lleven
// caller_env sin propagar el parámetro por toda la cadena de llamadas.
server.addHook("onRequest", (request, _reply, done) => {
  callerEnvStore.enterWith(callerEnvFromHeader(request.headers["x-aura-env"]));
  done();
});

// Healthcheck público para uptime (Better Stack). Sin auth, sin efectos.
server.get("/health", async (_request, reply) => {
  return reply.status(200).send({ status: "ok", service: "aura-scraper-api" });
});

// Semáforo de concurrencia — máx 2 instancias de Chromium simultáneas.
// Cada request a /scrape espera su turno; sin esto el container se queda sin
// threads y Chromium crashea con EAGAIN / SIGTRAP.
const MAX_CONCURRENT_SCRAPES = parseInt(process.env.MAX_CONCURRENT_SCRAPES ?? "2", 10);
let activeScrapes = 0;
const scrapeQueue: Array<() => void> = [];
const inFlightUrls = new Set<string>();

function acquireScrapeSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (activeScrapes < MAX_CONCURRENT_SCRAPES) {
      activeScrapes++;
      resolve();
    } else {
      scrapeQueue.push(() => { activeScrapes++; resolve(); });
    }
  });
}

function releaseScrapeSlot(): void {
  activeScrapes = Math.max(0, activeScrapes - 1);
  const next = scrapeQueue.shift();
  if (next) next();
}

// ── CORS Configuration ──────────────────────────────────────────────────────
server.register(fastifyCors, {
  origin: process.env.CORS_ORIGIN || ["http://localhost:3001", "http://localhost:3000"],
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
});

// Register static files to serve temporary images
server.register(fastifyStatic, {
  root: path.join(process.cwd(), "temp_images"),
  prefix: "/temp/",
});

// ── Error handler global (red de seguridad) ─────────────────────────────────
// Los handlers de cada ruta ya tienen su try/catch propio (y ahí se captura a
// Sentry con el tag operation). Este handler cubre lo que escape de esos
// try/catch: errores de parsing del body, hooks, plugins, etc. Solo se reporta
// a Sentry lo que no sea un 4xx esperable; la respuesta al cliente es la misma
// que daría el error handler default de Fastify (statusCode del error o 500).
server.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
  const statusCode = error.statusCode ?? 500;
  if (statusCode >= 500) {
    Sentry.captureException(error, {
      tags: {
        caller_env: callerEnvFromHeader(request.headers["x-aura-env"]),
        operation: request.routeOptions?.url ?? "unknown",
      },
    });
  }
  request.log.error(error);
  return reply.status(statusCode).send(error);
});

// ── POST /scrape ──────────────────────────────────────────────────────────
server.post("/scrape", async (request, reply) => {
  const callerEnv = callerEnvFromHeader(request.headers["x-aura-env"]);
  try {
    const { url, imageUrl } = request.body as { url: string; imageUrl?: string };

    if (!url) {
      recordScraperRequest("scrape", "bad_request", callerEnv);
      return reply.status(400).send({ error: "URL is required" });
    }

    if (inFlightUrls.has(url)) {
      server.log.warn(`Duplicate scrape rejected: ${url}`);
      recordScraperRequest("scrape", "duplicate", callerEnv);
      return reply.status(409).send({ error: "Esta URL ya tiene un scraping en proceso. Espera a que termine." });
    }

    inFlightUrls.add(url);
    server.log.info(`Scrape queued for: ${url} [queue=${scrapeQueue.length} active=${activeScrapes}/${MAX_CONCURRENT_SCRAPES}]`);
    await acquireScrapeSlot();
    server.log.info(`Scraping started for: ${url} [active=${activeScrapes}/${MAX_CONCURRENT_SCRAPES}]`);
    let scrapedData: Awaited<ReturnType<typeof scrapePerfumePage>>;
    try {
      // Duración del flujo de scraping propio (Playwright + LLM + búsqueda de imagen).
      scrapedData = await timeProviderCall("scraper", "scrape", () =>
        scrapePerfumePage(url, imageUrl)
      );
    } finally {
      releaseScrapeSlot();
      inFlightUrls.delete(url);
    }

    // Safety net 1: strip tester/decant variants the LLM included despite prompt instructions.
    // Filter is applied to all parallel arrays so indices stay aligned.
    if (Array.isArray(scrapedData.variantes)) {
      const TESTER_RE = /\b(tester|decant|muestra|sample)\b|\(t\)/i;
      const keepIdx: number[] = scrapedData.variantes
        .map((v: string, i: number) => (TESTER_RE.test(v) ? -1 : i))
        .filter((i: number) => i !== -1);

      if (keepIdx.length < scrapedData.variantes.length) {
        const removed = scrapedData.variantes.filter((_: string, i: number) => !keepIdx.includes(i));
        server.log.info(`[variant-fix] removed tester variants: ${JSON.stringify(removed)}`);
        scrapedData.variantes         = keepIdx.map((i: number) => scrapedData.variantes[i]);
        scrapedData.precios           = keepIdx.map((i: number) => (scrapedData.precios ?? [])[i]);
        scrapedData.precios_descuento = keepIdx.map((i: number) => (scrapedData.precios_descuento ?? [])[i] ?? 0);
        scrapedData.disponibilidad    = keepIdx.map((i: number) => (scrapedData.disponibilidad ?? [])[i]);
      }
    }

    // Safety net 2: divide by 100 if LLM forgot to convert Shopify centavos to COP pesos.
    // Max real COP perfume price confirmed at 6,000,000. Anything above that is raw Shopify centavos.
    const COP_MAX_REASONABLE = 6_000_000;
    if (Array.isArray(scrapedData.precios)) {
      scrapedData.precios = scrapedData.precios.map((p: number, i: number) => {
        if (p > COP_MAX_REASONABLE) {
          const fixed = Math.round(p / 100);
          server.log.info(`[price-fix] variant ${i}: divided by 100 (${p} → ${fixed})`);
          return fixed;
        }
        return p;
      });
    }
    if (Array.isArray(scrapedData.precios_descuento)) {
      scrapedData.precios_descuento = scrapedData.precios_descuento.map((p: number | null, i: number): number => {
        if (p == null) return 0;
        if (p > COP_MAX_REASONABLE) {
          const fixed = Math.round(p / 100);
          server.log.info(`[price-fix] variant ${i}: discount divided by 100 (${p} → ${fixed})`);
          return fixed;
        }
        return p;
      });
    }

    // Safety net 3: ensure precios >= precios_descuento per variant.
    // LLMs occasionally invert compare_at_price / price despite prompt instructions.
    if (Array.isArray(scrapedData.precios) && Array.isArray(scrapedData.precios_descuento)) {
      for (let i = 0; i < scrapedData.precios.length; i++) {
        const normal = scrapedData.precios[i];
        const desc = scrapedData.precios_descuento[i];
        if (desc != null && normal != null && desc > normal) {
          scrapedData.precios[i] = desc;
          scrapedData.precios_descuento[i] = normal;
          server.log.info(`[price-fix] variant ${i}: swapped inverted prices (${normal} ↔ ${desc})`);
        }
      }
    }

    // Create session to track this scrape
    const sessionId = createSession(scrapedData);

    recordScraperRequest("scrape", "success", callerEnv);
    return reply.status(200).send({
      sessionId,
      data: scrapedData,
    });
  } catch (error) {
    // Fallo completo del scrape (Playwright, LLM Fase 1/2, etc.) — además del
    // log pino, se reporta a Sentry con contexto de operación y caller.
    Sentry.captureException(error, {
      tags: { caller_env: callerEnv, operation: "scrape" },
    });
    server.log.error(error);
    recordScraperRequest("scrape", "error", callerEnv);
    return reply.status(500).send({ error: "Failed to scrape the page" });
  }
});

// ── POST /confirm-scrape ──────────────────────────────────────────────────
server.post("/confirm-scrape", async (request, reply) => {
  const callerEnv = callerEnvFromHeader(request.headers["x-aura-env"]);
  try {
    // Auth check
    if (!isValidToken(request.headers.authorization?.replace("Bearer ", ""))) {
      recordScraperRequest("confirm_scrape", "unauthorized", callerEnv);
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Missing or invalid API token",
      });
    }

    const { sessionId, data } = request.body as {
      sessionId?: string;
      data: Perfume;
    };

    if (!data) {
      recordScraperRequest("confirm_scrape", "bad_request", callerEnv);
      return reply.status(400).send({
        error: "data is required",
      });
    }

    // Session lookup is best-effort — sessions may have expired or be absent
    // when resuming a Firebase draft across scraper restarts.
    const session = sessionId ? getSession(sessionId) : null;

    // Validate data against schema
    const validationResult = PerfumeSchema.safeParse(data);
    if (!validationResult.success) {
      recordScraperRequest("confirm_scrape", "bad_request", callerEnv);
      return reply.status(400).send({
        error: "Invalid data",
        details: validationResult.error.issues,
      });
    }

    const confirmedData = validationResult.data;

    // Image is optional — products can be created without one and have it added
    // later via the catalog correction flow. The block below already guards on
    // `confirmedData.image` so the empty case is a no-op.
    if (confirmedData.image) {
      try {
        const originalImage = confirmedData.image;
        if (confirmedData.image.startsWith("data:")) {
          // Case 1: User uploaded image as data-uri
          server.log.info(`Optimizing user-uploaded image for: ${confirmedData.nombre}`);
          const imageResult = await validateAndOptimizeImageData(
            confirmedData.image,
            confirmedData.nombre
          );
          confirmedData.image = imageResult.dataUri;
          confirmedData.sourceImageUrl = "manual upload";

          server.log.info(
            `Image optimization: ${imageResult.originalSizeKB}KB → ${imageResult.optimizedSizeKB}KB`
          );
        } else {
          // Case 2: Image URL from Tavily search or direct URL - process and upload to S3
          server.log.info(`Processing and uploading image URL for: ${confirmedData.nombre}`);
          const s3Url = await processAndUploadImage(
            confirmedData.image,
            confirmedData.nombre
          );
          confirmedData.image = s3Url;
          confirmedData.sourceImageUrl = originalImage;

          server.log.info(`Image uploaded to S3: ${s3Url}`);
        }
      } catch (imgError: any) {
        recordScraperRequest("confirm_scrape", "bad_request", callerEnv);
        return reply.status(400).send({
          error: "Image processing failed",
          details: imgError.message,
        });
      }
    }

    // Update session if it exists (best-effort — may be absent for resumed drafts)
    if (session && sessionId) {
      updateSessionConfirmation(sessionId, confirmedData);
    }

    server.log.info(`Scrape confirmed${sessionId ? ` (session ${sessionId})` : " (sessionless)"}`);

    recordScraperRequest("confirm_scrape", "success", callerEnv);
    return reply.status(200).send({
      success: true,
      sessionId,
      validatedData: confirmedData,
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { caller_env: callerEnv, operation: "confirm_scrape" },
    });
    server.log.error(error);
    recordScraperRequest("confirm_scrape", "error", callerEnv);
    return reply.status(500).send({ error: "Failed to confirm scrape" });
  }
});

// ── POST /search-images ───────────────────────────────────────────────────────
server.post("/search-images", async (request, reply) => {
  const callerEnv = callerEnvFromHeader(request.headers["x-aura-env"]);
  try {
    if (!isValidToken(request.headers.authorization?.replace("Bearer ", ""))) {
      recordScraperRequest("search_images", "unauthorized", callerEnv);
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const { query } = request.body as { query?: string };
    if (!query?.trim()) {
      recordScraperRequest("search_images", "bad_request", callerEnv);
      return reply.status(400).send({ error: "query is required" });
    }

    const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });
    const response = await timeProviderCall("tavily", "search_images", () =>
      tvly.search(query.trim(), {
        searchDepth: "advanced",
        includeImages: true,
        maxResults: 10,
      })
    );

    const images: string[] = [];
    for (const img of (response.images as any[]) || []) {
      const url = typeof img === "string" ? img : img?.url;
      if (url && typeof url === "string" && images.length < 10) {
        images.push(url);
      }
    }

    recordScraperRequest("search_images", "success", callerEnv);
    return reply.status(200).send({ images });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { caller_env: callerEnv, operation: "search_images" },
    });
    server.log.error(error);
    recordScraperRequest("search_images", "error", callerEnv);
    return reply.status(500).send({ error: "Failed to search images" });
  }
});

// ── POST /sync-prices ─────────────────────────────────────────────────────
// Sync ligero de precio + disponibilidad: fetch determinista al JSON público
// de Shopify (<url>.js), sin Playwright ni LLM. Batch de hasta 20 URLs; el
// caller (job del backend Medusa) itera los chunks. Rate limiting en sync.ts.
const SYNC_PRICES_MAX_URLS = 20;

server.post("/sync-prices", async (request, reply) => {
  const callerEnv = callerEnvFromHeader(request.headers["x-aura-env"]);
  try {
    if (!isValidToken(request.headers.authorization?.replace("Bearer ", ""))) {
      recordScraperRequest("sync_prices", "unauthorized", callerEnv);
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const { urls } = request.body as { urls?: unknown };
    if (!Array.isArray(urls) || urls.length === 0 || !urls.every((u) => typeof u === "string" && u.trim())) {
      recordScraperRequest("sync_prices", "bad_request", callerEnv);
      return reply.status(400).send({ error: "urls must be a non-empty array of strings" });
    }
    if (urls.length > SYNC_PRICES_MAX_URLS) {
      recordScraperRequest("sync_prices", "bad_request", callerEnv);
      return reply.status(400).send({
        error: `Máximo ${SYNC_PRICES_MAX_URLS} URLs por request (recibidas: ${urls.length}). Itera en chunks.`,
      });
    }

    const response = await timeProviderCall("provider_shop", "sync_prices", () =>
      syncPrices(urls.map((u) => u.trim()))
    );

    const okCount = response.results.filter((r) => r.status === "ok").length;
    server.log.info(
      `[sync-prices] ${okCount}/${urls.length} ok, aborted=${response.aborted} [caller=${callerEnv}]`
    );

    recordScraperRequest("sync_prices", "success", callerEnv);
    return reply.status(200).send(response);
  } catch (error) {
    Sentry.captureException(error, {
      tags: { caller_env: callerEnv, operation: "sync_prices" },
    });
    server.log.error(error);
    recordScraperRequest("sync_prices", "error", callerEnv);
    return reply.status(500).send({ error: "Failed to sync prices" });
  }
});

// ── POST /search-urls ─────────────────────────────────────────────────────
// Búsqueda semántica de la URL de un producto en el sitio del proveedor
// (Tavily con site:), para el URL Manager del price-manager.
server.post("/search-urls", async (request, reply) => {
  const callerEnv = callerEnvFromHeader(request.headers["x-aura-env"]);
  try {
    if (!isValidToken(request.headers.authorization?.replace("Bearer ", ""))) {
      recordScraperRequest("search_urls", "unauthorized", callerEnv);
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const { query, limit } = request.body as { query?: string; limit?: number };
    if (!query?.trim()) {
      recordScraperRequest("search_urls", "bad_request", callerEnv);
      return reply.status(400).send({ error: "query is required" });
    }
    const maxResults = Math.min(Math.max(parseInt(String(limit ?? 5), 10) || 5, 1), 10);

    const searchHost = (process.env.SYNC_SEARCH_HOST || "disfragancias.com").trim();

    const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });
    const response = await timeProviderCall("tavily", "search_urls", () =>
      tvly.search(`site:${searchHost} ${query.trim()}`, {
        searchDepth: "basic",
        maxResults: 10,
      })
    );

    const seen = new Set<string>();
    const results: { title: string; url: string; score: number | null }[] = [];
    for (const r of (response.results as any[]) || []) {
      const url = typeof r?.url === "string" ? r.url : null;
      if (!url) continue;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        continue;
      }
      // Solo URLs de producto del host del proveedor
      if (!parsed.hostname.toLowerCase().endsWith(searchHost.toLowerCase())) continue;
      if (!parsed.pathname.includes("/products/")) continue;
      const clean = `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
      if (seen.has(clean)) continue;
      seen.add(clean);
      results.push({
        title: typeof r?.title === "string" ? r.title : clean,
        url: clean,
        score: typeof r?.score === "number" ? r.score : null,
      });
      if (results.length >= maxResults) break;
    }

    recordScraperRequest("search_urls", "success", callerEnv);
    return reply.status(200).send({ results });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { caller_env: callerEnv, operation: "search_urls" },
    });
    server.log.error(error);
    recordScraperRequest("search_urls", "error", callerEnv);
    return reply.status(500).send({ error: "Failed to search urls" });
  }
});

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || "3000", 10);
    await server.listen({ port, host: "0.0.0.0" });
    console.log(`Server listening on http://localhost:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();