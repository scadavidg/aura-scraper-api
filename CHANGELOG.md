# Changelog

Todas las versiones notables de este repo. Formato: SemVer.

## [1.0.1] - 2026-07-24

### Fixed
- `/sync-prices`: cuando `compare_at_price < price` se **descarta** la señal en
  vez de intercambiar los campos (#7). Ahí no hay inversión de campos sino dato
  sucio del proveedor (p.ej. un `compare_at` que trae el precio de otra talla),
  y el swap fabricaba ofertas ficticias — Moonlight 50 ML (`price=160.000`,
  `compare=25.000`) aparecía como un −84%. El propio Shopify no muestra ese
  `compare_at` tachado.

## [1.0.0] - 2026-07-15

Primera release formal. Etiqueta el estado ya en producción: scraping con
control de concurrencia, observabilidad OTel y endpoints de sync de precios.

### Added
- Endpoints `/sync-prices` y `/search-urls` para sync ligero de precios.
- `caller_env` en métrica de latencia de providers + endpoint `/health`.
- Integración de Sentry para captura de errores.
- Logs pino → OTel → Loki con filtro de severidad >= WARN.
- Métricas custom OTel `aura_scraper_*` (requests + duración de providers).
- OpenTelemetry tracing.

### Fixed
- LLM del scraper alucinaba `type_id` interno de Medusa inexistente.
- Semáforo de concurrencia: bug que dejaba el conteo activo sin decrementar.
- Rechazo de requests de scrape duplicados en vuelo (409).
- Unit `ms` duplicada en OTel; deployment.environment en mayúsculas por
  default.

### Removed
- Endpoint `/create-product` (violaba SRP).
