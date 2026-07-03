/**
 * Métricas custom OpenTelemetry `aura_*` del scraper-api.
 *
 * Solo depende de `@opentelemetry/api`: si el SDK no se inicializó (sin
 * OTEL_EXPORTER_OTLP_ENDPOINT, ver src/instrumentation.ts) el meter global es
 * no-op y registrar métricas no cuesta ni falla. Además, toda función pública
 * está envuelta en try/catch — las métricas NUNCA deben tumbar un request.
 *
 * Reglas de labels: solo enums de baja cardinalidad. Nunca URLs, nombres de
 * producto ni valores libres de headers.
 *
 * Servicio compartido entre entornos: cada request lleva `caller_env`,
 * derivado del header `x-aura-env` (fallback "PROD").
 */
import { metrics, type Counter, type Histogram } from "@opentelemetry/api"

// ── Enums de labels ─────────────────────────────────────────────────────────

export type ScraperOperation = "scrape" | "confirm_scrape" | "search_images"

export type ScraperRequestStatus =
  | "success"
  | "error"
  | "bad_request"
  | "unauthorized"
  | "duplicate"

export type ProviderName = "scraper" | "tavily" | "llm"

export type CallerEnv = "PROD" | "STAGING" | "DEV" | "OTHER"

// ── Instrumentos (lazy, singleton) ──────────────────────────────────────────

let requestsTotal: Counter | undefined
let providerDurationMs: Histogram | undefined

function getMeterInstruments(): {
  requestsTotal: Counter
  providerDurationMs: Histogram
} {
  if (!requestsTotal || !providerDurationMs) {
    const meter = metrics.getMeter("aura-scraper-api")
    requestsTotal = meter.createCounter("aura_scraper_requests_total", {
      description:
        "Total de requests a los endpoints del scraper, por operación, estado y entorno del caller",
    })
    providerDurationMs = meter.createHistogram(
      "aura_provider_request_duration_ms",
      {
        // Sin `unit`: el nombre ya termina en _ms y el gateway OTLP de Grafana
        // agregaría el sufijo _milliseconds, duplicando la unidad en Prometheus.
        description:
          "Duración en ms de llamadas a proveedores externos e internos (scraper propio, tavily, llm)",
      }
    )
  }
  return { requestsTotal, providerDurationMs }
}

// ── Helpers públicos ────────────────────────────────────────────────────────

/**
 * Normaliza el header `x-aura-env` a un enum de baja cardinalidad.
 * Sin header → "PROD" (comportamiento histórico del servicio compartido).
 * Valor desconocido → "OTHER" para no contaminar labels con texto libre.
 */
export function callerEnvFromHeader(header: unknown): CallerEnv {
  try {
    const raw = Array.isArray(header) ? header[0] : header
    if (typeof raw !== "string" || raw.trim() === "") return "PROD"
    const normalized = raw.trim().toUpperCase()
    if (normalized === "PROD" || normalized === "PRODUCTION") return "PROD"
    if (normalized === "STAGING") return "STAGING"
    if (normalized === "DEV" || normalized === "DEVELOPMENT") return "DEV"
    return "OTHER"
  } catch {
    return "PROD"
  }
}

/** Incrementa aura_scraper_requests_total{operation,status,caller_env}. */
export function recordScraperRequest(
  operation: ScraperOperation,
  status: ScraperRequestStatus,
  callerEnv: CallerEnv
): void {
  try {
    getMeterInstruments().requestsTotal.add(1, {
      operation,
      status,
      caller_env: callerEnv,
    })
  } catch {
    // Las métricas nunca lanzan.
  }
}

/** Registra aura_provider_request_duration_ms{provider,operation}. */
export function recordProviderDuration(
  provider: ProviderName,
  operation: string,
  durationMs: number
): void {
  try {
    if (!Number.isFinite(durationMs) || durationMs < 0) return
    getMeterInstruments().providerDurationMs.record(durationMs, {
      provider,
      operation,
    })
  } catch {
    // Las métricas nunca lanzan.
  }
}

/**
 * Mide la duración de una llamada a un proveedor y la registra, propagando
 * el resultado o el error original de la promesa sin alterarlos.
 */
export async function timeProviderCall<T>(
  provider: ProviderName,
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now()
  try {
    return await fn()
  } finally {
    recordProviderDuration(provider, operation, Date.now() - startedAt)
  }
}
