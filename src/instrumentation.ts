/**
 * OpenTelemetry para el scraper-api (Fastify + Pino).
 *
 * Se importa como PRIMERA línea de src/index.ts, antes que cualquier otro
 * módulo, para que las auto-instrumentaciones puedan parchear http/fastify/pino
 * al ser requeridos después.
 *
 * Exporta trazas y métricas por OTLP/HTTP al colector Grafana Alloy en la red
 * interna de Railway:
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://aura-observability-collector.railway.internal:4318
 * (los exporters le agregan /v1/traces y /v1/metrics respectivamente).
 *
 * Servicio compartido (1 solo prod, recibe tráfico prod+staging): el ambiente
 * por-request se marca vía baggage/atributo `aura.caller_env` desde el header
 * `x-aura-env`. Aquí solo se fija service.name y un deployment.environment base.
 *
 * Sin OTEL_EXPORTER_OTLP_ENDPOINT no instrumenta nada (seguro en local).
 */
import { NodeSDK } from "@opentelemetry/sdk-node"
import { resourceFromAttributes } from "@opentelemetry/resources"
import {
  ATTR_SERVICE_NAME,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from "@opentelemetry/semantic-conventions/incubating"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto"
import {
  PeriodicExportingMetricReader,
  AggregationType,
} from "@opentelemetry/sdk-metrics"
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http"
import { FastifyInstrumentation } from "@opentelemetry/instrumentation-fastify"
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino"

const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT

if (otlpEndpoint) {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "scraper-api",
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]:
        process.env.DEPLOYMENT_ENVIRONMENT || "PROD",
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
    instrumentations: [
      new HttpInstrumentation(),
      new FastifyInstrumentation(),
      // Inyecta trace_id/span_id en los logs de Pino para correlación.
      new PinoInstrumentation(),
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
