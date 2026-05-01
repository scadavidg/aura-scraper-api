# Investigación de Herramientas, MCPs y Skills para Aura Scraper API

El objetivo de esta API es extraer datos estructurados sobre perfumes desde diversas páginas web para alimentar la aplicación con información como nombre, precio, notas, descripción, entre otros. A continuación, se detallan los mejores Model Context Protocols (MCPs) y bibliotecas (skills) para construir esta solución de manera rápida y escalable.

## 1. El Desafío de Extracción de Datos
Dado el modelo de datos requerido:
```json
{
    "nombre": "Parfums De Marly Layton",
    "handle": "47e428a617",
    "coleccion": "Parfums De Marly",
    "volumen": 125,
    "precio": "1.290.000",
    "descripcion": "Layton de Parfums de Marly es una fragancia...",
    "genero": "Masculino",
    "clima": "Primavera, Otoño, Invierno",
    "acordes": "Especiado, Avainillado, Amaderado, Aromático, Frutal, Dulce",
    "concentracion": "Eau de Parfum",
    "pais": "Francia",
    "notas": "Manzana, lavanda, bergamota, mandarina...",
    "año": 2016,
    "categoria": "Nicho",
    "image": "https://url.com/image.png"
}
```
Necesitamos herramientas que no solo obtengan el HTML, sino que también puedan estructurar el contenido no estructurado (como descripciones largas o listas de notas) en el formato JSON estricto de arriba, y lidiar con páginas dinámicas (SPA) o protecciones anti-bot.

---

## 2. Mejores MCPs (Model Context Protocols)
Los MCPs permiten que el agente interactúe directamente con navegadores o APIs de scraping para crear los scripts y analizar la estructura de las webs.

### A. Firecrawl MCP (`firecrawl-mcp`) - **[Recomendado para Rapidez y Extracción]**
- **Por qué usarlo:** Firecrawl es una API especializada en convertir URLs completas en Markdown limpio o datos estructurados JSON. Tiene una funcionalidad específica llamada **Extract**, donde se le pasa un esquema de datos (como el modelo de arriba) y un LLM interno se encarga de extraer la información de la web y mapearla exactamente a esos campos.
- **Ventaja Escalable:** No tienes que mantener selectores CSS frágiles (ej. `.product-price-v2`). Si la página cambia su diseño, el LLM de Firecrawl seguirá encontrando el precio o las notas.
- **Instalación de MCP:** `npx -y firecrawl-mcp`

### B. Playwright MCP (`@playwright/mcp`) - **[Recomendado para Precisión e Interacción]**
- **Por qué usarlo:** Si las páginas requieren interactuar (por ejemplo, hacer clic en la variante de "125ml" para que el precio cambie a "1.290.000"), Playwright es ideal. Este MCP envía el "árbol de accesibilidad" de la página en lugar del HTML completo, lo cual ahorra tokens y permite comprender la página perfectamente.
- **Ventaja Escalable:** Es de código abierto, corre localmente o en contenedores, sin costos adicionales de API de scraping.

### C. Browserbase MCP (`@browserbasehq/mcp`) - **[Recomendado para Anti-Bot Extremo]**
- **Por qué usarlo:** Si vamos a scrapear tiendas con Cloudflare u otras protecciones agresivas, Browserbase ofrece navegadores en la nube que resuelven CAPTCHAs y gestionan proxies automáticamente. Usa `Stagehand` para interacciones naturales ("encuentra el precio del perfume").

---

## 3. Skills y Librerías (Tech Stack Recomendado para la API)

Para construir la API en sí (independientemente del MCP que usemos para el diseño), el stack ideal para Node.js / TypeScript es:

1. **Framework API:** **Fastify** o **Express** (Fastify es más rápido y escalable para APIs con alta concurrencia de scrapping).
2. **Validación de Datos (Schema):** **Zod**. Esencial para garantizar que el JSON de salida siempre cumpla con el modelo requerido (números en volumen, strings en notas).
3. **Motores de Scraping:**
   - **Playwright / Puppeteer:** Para sitios dinámicos y Single Page Applications (React/Next.js/Vue).
   - **Cheerio + Axios/Fetch:** Para sitios estáticos tradicionales (extremadamente rápido y ligero, pero no ejecuta JavaScript).
4. **Estructuración con IA:** Utilizar **Vercel AI SDK** u **OpenAI SDK** (con `response_format: { type: "json_object" }`) pasándole el Markdown de la página para que devuelva exactamente tu JSON modelo.
5. **Colas de Trabajo (Job Queues):** **BullMQ** + **Redis**. El scraping no debe ser síncrono. La API debería recibir la solicitud, encolarla, y realizar el scraping en background con reintentos automáticos si falla por rate-limits.

---

## 4. Arquitectura Propuesta para Aura Scraper API

1. **Endpoint `POST /scrape`:** Recibe una URL y opcionalmente el identificador (handle).
2. **Procesador (Worker):**
   - Extrae el contenido de la página usando Playwright o Firecrawl.
   - Pasa el contenido bruto (Markdown/HTML) por un LLM ligero (o usando la API Extract de Firecrawl) con el esquema `Zod` del Perfume.
   - Retorna el JSON limpio y estructurado.
3. **Escalabilidad:** Al separar el scraper de la API principal, podemos correr múltiples instancias del worker detrás de proxies rotativos.

**Siguiente paso sugerido:** Inicializar un proyecto Node.js/TypeScript y configurar un entorno básico de scraping con una herramienta como Playwright + Zod para probar con una URL de ejemplo.