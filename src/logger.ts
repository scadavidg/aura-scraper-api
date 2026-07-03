/**
 * Logger pino compartido para módulos que corren fuera del handle directo de
 * Fastify (scraper, image-processor) y que antes usaban console.error.
 *
 * Al ser pino, la instrumentación OTel (@opentelemetry/instrumentation-pino)
 * le inyecta trace_id/span_id automáticamente cuando hay un span activo y
 * reenvía los registros al pipeline OTel → Loki (filtrados a >= WARN en
 * src/instrumentation.ts). Fastify mantiene su propia instancia pino
 * (logger: true), también instrumentada.
 */
import pino from "pino"

export const logger = pino()
