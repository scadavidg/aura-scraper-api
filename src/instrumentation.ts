/**
 * OpenTelemetry para el scraper-api (Fastify + Pino).
 *
 * Se importa como PRIMERA línea de src/index.ts, antes que cualquier otro
 * módulo, para que las auto-instrumentaciones puedan parchear http/fastify/pino
 * al ser requeridos después.
 *
 * Exporta trazas por OTLP/HTTP al colector Grafana Alloy en la red interna de
 * Railway:
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://aura-observability-collector.railway.internal:4318
 * (el exporter le agrega /v1/traces).
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
