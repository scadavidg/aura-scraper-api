/**
 * Sync ligero de precio + disponibilidad contra el proveedor (disfragancias).
 *
 * A diferencia de /scrape (Playwright + LLM, 15-30s), esto hace UN fetch al
 * endpoint JSON público de Shopify (`<product-url>.js`) y parsea de forma
 * 100% determinista: sin browser, sin LLM, <1s por producto.
 *
 * Rate limiting hacia el proveedor (obligatorio — sin esto Shopify banea la IP):
 *  - Semáforo global de concurrencia (default 1): los fetch salen secuenciales
 *    aunque lleguen varios batches en paralelo.
 *  - Delay aleatorio entre fetches (default 500-1500ms).
 *  - Backoff en 429/503: 5s → 15s → 45s (máx 3 intentos). 404 NO reintenta.
 *  - Si 2 URLs consecutivas agotan reintentos → aborta el batch y sugiere
 *    retry_after_ms al caller (el job del backend pausa el run).
 */

// ── Config (env) ─────────────────────────────────────────────────────────────

function allowedHosts(): string[] {
  return (process.env.SYNC_ALLOWED_HOSTS || "disfragancias.com,www.disfragancias.com")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

const SYNC_DELAY_MIN_MS = parseInt(process.env.SYNC_DELAY_MIN_MS ?? "500", 10);
const SYNC_DELAY_MAX_MS = parseInt(process.env.SYNC_DELAY_MAX_MS ?? "1500", 10);
const MAX_CONCURRENT_SYNC = parseInt(process.env.MAX_CONCURRENT_SYNC ?? "1", 10);
const FETCH_TIMEOUT_MS = 10_000;
const BACKOFF_MS = [5_000, 15_000, 45_000];
const ABORT_AFTER_CONSECUTIVE_FAILURES = 2;
const SUGGESTED_RETRY_AFTER_MS = 600_000; // 10 min

// Mismo UA de navegador realista que usa Playwright en scraper.ts
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Formatos que NO vendemos: el proveedor los lista pero nunca deben entrar al
// catálogo ni generar reportes de variante nueva. Fuente única de verdad para
// el sync de precios y para el safety net 1 de /scrape (index.ts).
// `vial` se agregó tras ver el proveedor publicar "2 ML (Vial)" / "3 ML (Vial)".
export const TESTER_RE =
  /\b(tester|decant|decants|muestra|sample|vial|vials|miniatura)\b|body\s*(?:spray|mist)|set\s*de\s*regalo|gift\s*set|\(t\)/i;

/**
 * Talla VENDIBLE: 2 o 3 cifras + ML, con o sin espacio, cualquier
 * capitalización, y NADA más. "50 ML" · "50ml" · "100 mL" · "236ML".
 *
 * Whitelist: el proveedor estrena calificativos nuevos cada tanto (Tester →
 * Decant → Vial → Body Spray) y la blacklist de arriba siempre llega tarde.
 * Se usa en el camino de ALTA de producto (/scrape), donde el título nace de
 * cero y no hay nada que romper.
 *
 * `/ Standard` es la opción de relleno que concatena el Shopify del proveedor
 * cuando el producto tiene una segunda opción sin variantes reales; se pela
 * porque no aporta nada. Sólo ese literal: "100 ML / Tester" sigue inválido.
 */
const RETAIL_TITLE_RE = /^\d{2,3}\s*ml$/i;
const SHOPIFY_FILLER_OPTION_RE = /\s*\/\s*standard\s*$/i;

export function isRetailVariantTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return RETAIL_TITLE_RE.test(title.trim().replace(SHOPIFY_FILLER_OPTION_RE, "").trim());
}

// Precio COP máximo razonable (misma constante que safety net 2 de /scrape)
const COP_MAX_REASONABLE = 6_000_000;

// ── Tipos ────────────────────────────────────────────────────────────────────

export type SyncUrlStatus =
  | "ok"
  | "http_404"
  | "http_429"
  | "http_error"
  | "network_error"
  | "not_shopify_json"
  | "invalid_host";

export interface SyncVariant {
  provider_variant_id: number | null;
  title: string;
  /** Precio base en COP pesos (compare_at_price ?? price, ÷100 determinista) */
  price: number;
  /** Precio tachado en COP pesos; null si no hay descuento */
  compare_at_price: number | null;
  available: boolean;
}

export interface SyncUrlResult {
  url: string;
  status: SyncUrlStatus;
  fetched_at: string;
  /** `res.url` tras seguir redirects, desnormalizado del `.js` (ver `denormalizeShopifyJsUrl`). Solo si hubo respuesta HTTP. */
  final_url?: string;
  /** true si `final_url` apunta a un recurso distinto al `url` pedido (ver `isSameProductUrl`). Solo si hubo respuesta HTTP. */
  redirected?: boolean;
  http_status?: number;
  error?: string;
  product?: {
    title: string;
    handle: string;
    variants: SyncVariant[];
  };
}

export interface SyncPricesResponse {
  results: SyncUrlResult[];
  aborted: boolean;
  retry_after_ms: number | null;
}

// ── Semáforo global hacia el proveedor ───────────────────────────────────────
// Instancia separada del semáforo Playwright de index.ts: este limita los
// fetch HTTP al proveedor, no los procesos Chromium.

let activeSyncs = 0;
const syncQueue: Array<() => void> = [];

function acquireSyncSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (activeSyncs < MAX_CONCURRENT_SYNC) {
      activeSyncs++;
      resolve();
    } else {
      syncQueue.push(() => {
        activeSyncs++;
        resolve();
      });
    }
  });
}

function releaseSyncSlot(): void {
  activeSyncs = Math.max(0, activeSyncs - 1);
  const next = syncQueue.shift();
  if (next) next();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs(): number {
  const min = Math.max(0, SYNC_DELAY_MIN_MS);
  const max = Math.max(min, SYNC_DELAY_MAX_MS);
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Desnormaliza `res.url` (la URL final tras seguir redirects) de vuelta a una
 * URL "de producto". El fetch siempre pide `<url>.js`; si Shopify redirige el
 * handle, `res.url` también termina en `.../<otro-handle>.js`. Quitamos ese
 * sufijo para que `final_url` sea comparable/usable como URL de producto real
 * (ej. para guardarla como nuevo `scraper_source_url`). Si por algún motivo la
 * URL final no termina en `.js` (redirect a otra ruta), se devuelve tal cual.
 */
export function denormalizeShopifyJsUrl(finalUrl: string): string {
  try {
    const parsed = new URL(finalUrl);
    if (parsed.pathname.endsWith(".js")) {
      parsed.pathname = parsed.pathname.slice(0, -3);
    }
    return parsed.toString();
  } catch {
    return finalUrl;
  }
}

/**
 * Compara dos URLs de producto para decidir si son "la misma", ignorando lo
 * que no cambia el recurso: mayúsculas del host (los hosts no distinguen
 * mayúsculas), un prefijo `www.` (ver nota abajo), query string (ej.
 * `?variant=`), hash, y un `/` final redundante en el path. El path SÍ es
 * sensible a mayúsculas: Shopify trata handles con distinta capitalización
 * como recursos distintos.
 *
 * Por qué se quita `www.`: disfragancias sirve el mismo catálogo en
 * `disfragancias.com` y `www.disfragancias.com` — ambos están en
 * `SYNC_ALLOWED_HOSTS` — y `www.` 301-redirige al apex. Validado en vivo: un
 * `scraper_source_url` guardado con `www.` terminaba SIEMPRE en el apex tras
 * seguir el redirect, así que sin esta normalización `redirected` daba
 * true en cada sync para todo producto con `www.` guardado — falso positivo
 * masivo de `url_moved` desde el primer run, no una detección real de handle
 * movido. Solo se pela el prefijo literal `www.`, no subdominios arbitrarios
 * (`shop.d.com` sigue siendo distinto de `d.com`).
 */
export function isSameProductUrl(a: string, b: string): boolean {
  try {
    const pa = new URL(a);
    const pb = new URL(b);
    const normalizePath = (path: string) => path.replace(/\/+$/, "") || "/";
    const normalizeHost = (host: string) => host.toLowerCase().replace(/^www\./, "");
    const originOf = (u: URL) => `${u.protocol}//${normalizeHost(u.host)}`;
    return originOf(pa) === originOf(pb) && normalizePath(pa.pathname) === normalizePath(pb.pathname);
  } catch {
    return a === b;
  }
}

/** Deriva `final_url`/`redirected` a partir de la respuesta HTTP recibida. */
function finalUrlFields(response: Response, requestedUrl: string): { final_url: string; redirected: boolean } {
  const final_url = denormalizeShopifyJsUrl(response.url);
  return { final_url, redirected: !isSameProductUrl(final_url, requestedUrl) };
}

/** Deriva la URL del endpoint JSON de Shopify desde la URL del producto. */
export function toShopifyJsUrl(productUrl: string): { jsUrl: string; host: string } | null {
  try {
    const parsed = new URL(productUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const cleanPath = parsed.pathname.replace(/\/$/, "");
    if (!cleanPath) return null;
    return {
      jsUrl: `${parsed.origin}${cleanPath}.js`,
      host: parsed.hostname.toLowerCase(),
    };
  } catch {
    return null;
  }
}

/** Centavos Shopify → COP pesos. El .js SIEMPRE devuelve centavos. */
function centsToPesos(cents: number): number {
  let pesos = Math.round(cents / 100);
  // Red de seguridad: si algo ya venía en pesos y superamos el techo real,
  // no dividimos de nuevo — pero si el valor sigue absurdo tras ÷100 es que
  // venía con doble escala; se corrige una vez más.
  if (pesos > COP_MAX_REASONABLE) pesos = Math.round(pesos / 100);
  return pesos;
}

function normalizeVariants(rawVariants: any[]): SyncVariant[] {
  const out: SyncVariant[] = [];
  for (const v of rawVariants) {
    const title = String(v?.title ?? "").trim();
    // Blacklist (no whitelist) a propósito: acá el resultado alimenta el
    // MATCHER del backend contra el catálogo ya existente. Descartar un título
    // que no sea talla limpia ("100 ML EDP") borraría del sync una variante
    // nuestra viva y la reportaría como variant_missing falso. El gate de talla
    // estricta vive donde se decide CREAR (backend: isRetailVariantTitle).
    if (!title || TESTER_RE.test(title)) continue; // excluir tester/decant/vial/body spray

    const rawPrice = Number(v?.price);
    if (!Number.isFinite(rawPrice) || rawPrice <= 0) continue;

    const rawCompareAt =
      v?.compare_at_price != null && Number.isFinite(Number(v.compare_at_price)) && Number(v.compare_at_price) > 0
        ? Number(v.compare_at_price)
        : null;

    let price = centsToPesos(rawPrice);
    let compareAt = rawCompareAt != null ? centsToPesos(rawCompareAt) : null;

    // Sanidad: compare_at (precio tachado) debe ser >= price. A diferencia del
    // path /scrape (LLM, que puede invertir campos y ahí SÍ se hace swap), aquí
    // leemos JSON Shopify determinista: si compare_at < price es dato sucio del
    // proveedor (p.ej. compare_at con el precio de otra talla). Shopify mismo no
    // lo muestra tachado. Descartar la señal, NO intercambiar (un swap fabrica
    // una oferta ficticia — ej. 50 ML price=160000/compare=25000 → -84%).
    if (compareAt != null && compareAt < price) compareAt = null;
    // compare_at igual al price no aporta señal de descuento
    if (compareAt != null && compareAt === price) compareAt = null;

    out.push({
      provider_variant_id: Number.isFinite(Number(v?.id)) ? Number(v.id) : null,
      title,
      price,
      compare_at_price: compareAt,
      available: Boolean(v?.available),
    });
  }
  return out;
}

// ── Fetch de una URL con backoff ─────────────────────────────────────────────

/**
 * Resultado interno: además del SyncUrlResult, indica si la URL agotó los
 * reintentos por rate-limit (para la lógica de abort del batch).
 */
async function fetchOne(productUrl: string): Promise<{ result: SyncUrlResult; rateLimited: boolean }> {
  const fetchedAt = () => new Date().toISOString();

  const derived = toShopifyJsUrl(productUrl);
  if (!derived) {
    return {
      result: { url: productUrl, status: "invalid_host", fetched_at: fetchedAt(), error: "URL inválida" },
      rateLimited: false,
    };
  }
  if (!allowedHosts().includes(derived.host)) {
    return {
      result: {
        url: productUrl,
        status: "invalid_host",
        fetched_at: fetchedAt(),
        error: `Host "${derived.host}" no permitido`,
      },
      rateLimited: false,
    };
  }

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    let response: Response;
    try {
      response = await fetch(derived.jsUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          "Accept-Language": "es-CO,es;q=0.9",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err: any) {
      return {
        result: {
          url: productUrl,
          status: "network_error",
          fetched_at: fetchedAt(),
          error: err?.message ?? "network error",
        },
        rateLimited: false,
      };
    }

    if (response.status === 404) {
      // URL rota — no reintentar; el backend la marca para re-scan en el URL Manager
      return {
        result: {
          url: productUrl,
          status: "http_404",
          fetched_at: fetchedAt(),
          http_status: 404,
          ...finalUrlFields(response, productUrl),
        },
        rateLimited: false,
      };
    }

    if (response.status === 429 || response.status === 503) {
      if (attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      return {
        result: {
          url: productUrl,
          status: "http_429",
          fetched_at: fetchedAt(),
          http_status: response.status,
          error: `Rate limited (${response.status}) tras ${BACKOFF_MS.length + 1} intentos`,
          ...finalUrlFields(response, productUrl),
        },
        rateLimited: true,
      };
    }

    if (!response.ok) {
      return {
        result: {
          url: productUrl,
          status: "http_error",
          fetched_at: fetchedAt(),
          http_status: response.status,
          error: `HTTP ${response.status}`,
          ...finalUrlFields(response, productUrl),
        },
        rateLimited: false,
      };
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      return {
        result: {
          url: productUrl,
          status: "not_shopify_json",
          fetched_at: fetchedAt(),
          error: "La respuesta no es JSON válido",
          ...finalUrlFields(response, productUrl),
        },
        rateLimited: false,
      };
    }

    if (!data || !Array.isArray(data.variants)) {
      return {
        result: {
          url: productUrl,
          status: "not_shopify_json",
          fetched_at: fetchedAt(),
          error: "El JSON no tiene el shape de producto Shopify (falta variants[])",
          ...finalUrlFields(response, productUrl),
        },
        rateLimited: false,
      };
    }

    return {
      result: {
        url: productUrl,
        status: "ok",
        fetched_at: fetchedAt(),
        http_status: response.status,
        ...finalUrlFields(response, productUrl),
        product: {
          title: String(data.title ?? ""),
          handle: String(data.handle ?? ""),
          variants: normalizeVariants(data.variants),
        },
      },
      rateLimited: false,
    };
  }

  // Inalcanzable (el loop siempre retorna), pero TypeScript necesita el cierre.
  return {
    result: { url: productUrl, status: "http_error", fetched_at: fetchedAt(), error: "unexpected" },
    rateLimited: false,
  };
}

// ── API pública ──────────────────────────────────────────────────────────────

/**
 * Procesa un batch de URLs (máx definido por el endpoint) de forma secuencial
 * bajo el semáforo global, con delay aleatorio entre fetches.
 */
export async function syncPrices(urls: string[]): Promise<SyncPricesResponse> {
  const results: SyncUrlResult[] = [];
  let consecutiveRateLimits = 0;
  let aborted = false;

  for (let i = 0; i < urls.length; i++) {
    await acquireSyncSlot();
    try {
      if (i > 0) await sleep(randomDelayMs());
      const { result, rateLimited } = await fetchOne(urls[i]);
      results.push(result);

      if (rateLimited) {
        consecutiveRateLimits++;
        if (consecutiveRateLimits >= ABORT_AFTER_CONSECUTIVE_FAILURES) {
          aborted = true;
        }
      } else {
        consecutiveRateLimits = 0;
      }
    } finally {
      releaseSyncSlot();
    }

    if (aborted) break;
  }

  return {
    results,
    aborted,
    retry_after_ms: aborted ? SUGGESTED_RETRY_AFTER_MS : null,
  };
}
