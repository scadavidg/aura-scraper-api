import fastify from "fastify";
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
import { mapPerfumeToMedusaProduct } from "./medusa-mapper";
import { validateAndOptimizeImageData, processAndUploadImage } from "./image-processor";
import { authMiddleware, isValidToken, registerToken } from "./auth";
import { tavily } from "@tavily/core";

dotenv.config();

// ── API Test Push ──────────────────────────────────────────────────────────
// Register token from env after dotenv is configured
if (process.env.SCRAPER_API_TOKEN) {
  registerToken(process.env.SCRAPER_API_TOKEN, "default");
}

const server = fastify({ logger: true });

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

// ── POST /scrape ──────────────────────────────────────────────────────────
server.post("/scrape", async (request, reply) => {
  try {
    const { url, imageUrl } = request.body as { url: string; imageUrl?: string };

    if (!url) {
      return reply.status(400).send({ error: "URL is required" });
    }

    server.log.info(`Scraping started for: ${url}${imageUrl ? ` with direct image: ${imageUrl}` : ''}`);
    const scrapedData = await scrapePerfumePage(url, imageUrl);

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

    return reply.status(200).send({
      sessionId,
      data: scrapedData,
    });
  } catch (error) {
    server.log.error(error);
    return reply.status(500).send({ error: "Failed to scrape the page" });
  }
});

// ── POST /confirm-scrape ──────────────────────────────────────────────────
server.post("/confirm-scrape", async (request, reply) => {
  try {
    // Auth check
    if (!isValidToken(request.headers.authorization?.replace("Bearer ", ""))) {
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

    return reply.status(200).send({
      success: true,
      sessionId,
      validatedData: confirmedData,
    });
  } catch (error) {
    server.log.error(error);
    return reply.status(500).send({ error: "Failed to confirm scrape" });
  }
});

// ── POST /create-product ──────────────────────────────────────────────────
server.post("/create-product", async (request, reply) => {
  try {
    // Auth check
    if (!isValidToken(request.headers.authorization?.replace("Bearer ", ""))) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Missing or invalid API token",
      });
    }

    const { sessionId, data: directData } = request.body as {
      sessionId?: string;
      data?: Perfume;
    };

    // Resolve confirmed data: prefer inline data (stateless), fall back to session
    let confirmedData: Perfume | undefined;

    if (directData) {
      confirmedData = directData;
    } else if (sessionId) {
      const session = getSession(sessionId);
      if (!session) {
        return reply.status(404).send({ error: "Session not found or expired" });
      }
      if (!session.confirmedData) {
        return reply.status(400).send({
          error: "No confirmed data in session. Call /confirm-scrape first.",
        });
      }
      confirmedData = session.confirmedData;
    } else {
      return reply.status(400).send({ error: "Provide either data or sessionId" });
    }

    // Image is optional — medusa-mapper handles the empty case (images: []).
    const useNewEndpoint = process.env.USE_NEW_IMPORT_ENDPOINT === "true";
    const medusaBase = (process.env.MEDUSA_BACKEND_URL || "").replace(/\/$/, "");
    let response;

    if (useNewEndpoint) {
      // NEW: Use /store/products/import
      // Filter out possibleImages as it's not needed by the backend
      const { possibleImages, ...perfumeData } = confirmedData;

      const medusaUrl = `${medusaBase}/store/products/import`;
      server.log.info(`Using new import endpoint: ${medusaUrl}`);
      
      response = await fetch(medusaUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-publishable-api-key": process.env.MEDUSA_PUBLISHABLE_API_KEY || "",
          "x-price-manager-key": process.env.PRICE_MANAGER_API_KEY || "",
        },
        body: JSON.stringify({ perfumes: [perfumeData] }),
      });
    } else {
      // OLD: Use /store/price-manager/products (legacy batch)
      const medusaProduct = mapPerfumeToMedusaProduct(confirmedData);
      const medusaUrl = `${medusaBase}/store/price-manager/products`;
      server.log.info(`Using legacy endpoint: ${medusaUrl}`);

      response = await fetch(medusaUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-publishable-api-key": process.env.MEDUSA_PUBLISHABLE_API_KEY || "",
          "x-price-manager-key": process.env.PRICE_MANAGER_API_KEY || "",
        },
        body: JSON.stringify(medusaProduct),
      });
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      server.log.error("Medusa error:", errorData);
      return reply.status(502).send({
        error: "Failed to create product in Medusa",
        details: errorData,
      });
    }

    const createdProduct = await response.json();

    // Build storefront URL by fetching actual category handles from Medusa
    // (mirrors frontend getProductUrl logic: /productos/{cat1}/{cat2}/{handle})
    const buildStorefrontUrl = async (productId: string, handle: string): Promise<string | null> => {
      const base = process.env.STOREFRONT_URL;
      if (!base) return null;
      const baseClean = base.replace(/\/$/, "");
      const fallback = `${baseClean}/co/productos/${handle}`;
      try {
        const productRes = await fetch(
          `${medusaBase}/store/price-manager/products/${productId}`,
          {
            headers: {
              "x-price-manager-key": process.env.PRICE_MANAGER_API_KEY || "",
              "x-publishable-api-key": process.env.MEDUSA_PUBLISHABLE_API_KEY || "",
            },
          }
        );
        if (!productRes.ok) return fallback;
        const product = await productRes.json();
        const categoryHandles: string[] = (product.categories || [])
          .map((c: any) => c.handle)
          .filter((h: any) => typeof h === "string" && h.trim());
        if (categoryHandles.length === 0) return fallback;
        return `${baseClean}/co/productos/${categoryHandles.join("/")}/${handle}`;
      } catch {
        return fallback;
      }
    };

    if (useNewEndpoint) {
      const result = createdProduct.results?.[0];

      // Surface workflow errors even when Medusa returns 200
      if (!result?.product_id || (result?.errors?.length > 0)) {
        const errMsg = result?.errors?.[0] || "Workflow returned no product_id";
        server.log.error("Medusa workflow error:", errMsg, result);
        return reply.status(502).send({
          error: "Failed to create product in Medusa",
          details: errMsg,
        });
      }

      const handle = result?.handle || confirmedData.handle;
      const productId = result?.product_id;
      server.log.info(
        `Product processed via new import: ${handle} (${result?.action})`
      );

      return reply.status(201).send({
        success: true,
        productId,
        handle,
        storefrontUrl: await buildStorefrontUrl(productId, handle),
        action: result?.action,
        message: `Product ${result?.action} successfully via new import`,
      });
    } else {
      const pid = createdProduct.product?.id || createdProduct.id;
      const handle = createdProduct.product?.handle || confirmedData.handle;
      server.log.info(`Product created successfully via legacy: ${pid}`);

      return reply.status(201).send({
        success: true,
        productId: pid,
        handle,
        storefrontUrl: await buildStorefrontUrl(pid, handle),
        message: "Product created successfully via legacy",
      });
    }
  } catch (error) {
    server.log.error(error);
    return reply.status(500).send({ error: "Failed to create product" });
  }
});

// ── POST /search-images ───────────────────────────────────────────────────────
server.post("/search-images", async (request, reply) => {
  try {
    if (!isValidToken(request.headers.authorization?.replace("Bearer ", ""))) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const { query } = request.body as { query?: string };
    if (!query?.trim()) {
      return reply.status(400).send({ error: "query is required" });
    }

    const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });
    const response = await tvly.search(query.trim(), {
      searchDepth: "advanced",
      includeImages: true,
      maxResults: 10,
    });

    const images: string[] = [];
    for (const img of (response.images as any[]) || []) {
      const url = typeof img === "string" ? img : img?.url;
      if (url && typeof url === "string" && images.length < 10) {
        images.push(url);
      }
    }

    return reply.status(200).send({ images });
  } catch (error) {
    server.log.error(error);
    return reply.status(500).send({ error: "Failed to search images" });
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