/**
 * OpenTelemetry para el scraper-api (Fastify + Pino).
 *
 * Se importa como PRIMERA línea de src/index.ts, antes que cualquier otro
 * módulo, para que las auto-instrumentaciones puedan parchear http/fastify/pino
 * al ser requeridos después.
 *
 * Exporta trazas, métricas y logs por OTLP/HTTP al colector Grafana Alloy en la
 * red interna de Railway:
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://aura-observability-collector.railway.internal:4318
 * (los exporters le agregan /v1/traces, /v1/metrics y /v1/logs respectivamente).
 *
 * Logs: la instrumentación de Pino reenvía los logs del servicio al pipeline
 * OTel (→ Loki). Para no quemar cuota de Loki se filtra a severidad >= WARN
 * antes del batch (INFO/DEBUG se descartan; siguen saliendo por stdout).
 *
 * Servicio compartido (1 solo prod, recibe tráfico prod+staging): el ambiente
 * por-request se marca vía baggage/atributo `aura.caller_env` desde el header
 * `x-aura-env`. Aquí solo se fija service.name y un deployment.environment base.
 *
 * Sin OTEL_EXPORTER_OTLP_ENDPOINT no instrumenta nada (seguro en local).
 */
import { NodeSDK } from "@opentelemetry/sdk-node"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto"
import {
  PeriodicExportingMetricReader,
  AggregationType,
} from "@opentelemetry/sdk-metrics"
import {
  BatchLogRecordProcessor,
  type LogRecordProcessor,
  type SdkLogRecord,
} from "@opentelemetry/sdk-logs"
import { SeverityNumber } from "@opentelemetry/api-logs"
import type { Context } from "@opentelemetry/api"
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http"
import { FastifyInstrumentation } from "@opentelemetry/instrumentation-fastify"
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino"

const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT

/**
 * Wrapper de LogRecordProcessor que descarta registros por debajo de una
 * severidad mínima ANTES de que entren al batch/export. Evita mandar
 * INFO/DEBUG (ruido de Fastify por-request) a Loki y quemar cuota; a Loki
 * solo llegan WARN/ERROR/FATAL. Los logs completos siguen en stdout (Railway).
 */
class MinSeverityLogProcessor implements LogRecordProcessor {
  constructor(
    private readonly inner: LogRecordProcessor,
    private readonly minSeverity: SeverityNumber
  ) {}

  onEmit(logRecord: SdkLogRecord, context?: Context): void {
    const severity = logRecord.severityNumber ?? SeverityNumber.UNSPECIFIED
    if (severity < this.minSeverity) return
    this.inner.onEmit(logRecord, context)
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush()
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }
}

if (otlpEndpoint) {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "scraper-api",
      // Convención vieja "deployment.environment" a propósito: es la que usan
      // backend/notification y la que el gateway de Grafana promueve al label
      // deployment_environment (la incubating "…environment.name" genera otro label).
      "deployment.environment": process.env.DEPLOYMENT_ENVIRONMENT || "PROD",
    }),
    traceExporter: new OTLPTraceExporter(),
    // Métricas custom aura_* (ver src/metrics.ts) — export cada 30s al mismo
    // endpoint base OTLP (el exporter le agrega /v1/metrics).
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 30_000,
      }),
    ],
    views: [
      // Buckets explícitos en ms para todos los histogramas aura_*_duration_ms.
      {
        instrumentName: "aura_*_duration_ms",
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: {
            boundaries: [
              5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
            ],
          },
        },
      },
    ],
    // Logs → OTLP (/v1/logs) → Alloy → Loki. El wrapper filtra a >= WARN
    // antes del BatchLogRecordProcessor para no quemar cuota de Loki.
    logRecordProcessors: [
      new MinSeverityLogProcessor(
        new BatchLogRecordProcessor(new OTLPLogExporter()),
        SeverityNumber.WARN
      ),
    ],
    instrumentations: [
      new HttpInstrumentation(),
      new FastifyInstrumentation(),
      // Inyecta trace_id/span_id en los logs de Pino para correlación y
      // reenvía cada log al LoggerProvider global (disableLogSending: false
      // es el default en 0.65.x; explícito para dejar la intención clara).
      new PinoInstrumentation({ disableLogSending: false }),
    ],
  })

  sdk.start()

  // Apagado limpio: flush de spans pendientes antes de morir.
  const shutdown = () => {
    sdk
      .shutdown()
      .catch((err) => console.error("otel shutdown error", err))
      .finally(() => process.exit(0))
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}
