import { chromium } from "playwright";
import { generateObject, generateText } from "ai";
import { google } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { tavily } from "@tavily/core";
import { z } from "zod";
import dotenv from "dotenv";
import { PerfumeSchema } from "./schema";
import { processAndUploadImage } from "./image-processor";
import { timeProviderCall } from "./metrics";

dotenv.config();

// Configuración de Clientes
const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPEN_ROUTER_API_KEY,
});

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

// Verificar que la API key de Google está presente
if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  throw new Error("GOOGLE_GENERATIVE_AI_API_KEY env var not set");
}

async function tavilyImageSearch(query: string): Promise<string[]> {
  const response = await timeProviderCall("tavily", "image_search", () =>
    tvly.search(query, {
      searchDepth: "advanced",
      includeImages: true,
      maxResults: 10,
    })
  );
  const images = (response.images as any[]) || [];
  const urls: string[] = [];
  for (const img of images) {
    const url = typeof img === "string" ? img : img?.url;
    if (url && urls.length < 3) urls.push(url);
  }
  return urls;
}

async function searchProductImages(perfumeName: string): Promise<string[]> {
  // Try queries in order, stop at first that yields results.
  // 1. Fragrantica (preferred — high-quality canonical packshots).
  // 2. Generic web search — fallback when Fragrantica has no entry for the perfume.
  const queries = [
    `site:fragrantica.es perfume ${perfumeName}`,
    `perfume ${perfumeName}`,
  ];

  for (const q of queries) {
    try {
      console.log(`[image-search] querying Tavily: "${q}"`);
      const urls = await tavilyImageSearch(q);
      if (urls.length > 0) {
        console.log(`[image-search] ${urls.length} imagen(es) vía "${q}"`);
        return urls;
      }
      console.log(`[image-search] 0 resultados para "${q}", probando fallback…`);
    } catch (error) {
      console.error(`[image-search] error en "${q}":`, error);
    }
  }
  return [];
}

export async function scrapePerfumePage(url: string, directImageUrl?: string) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();
  
  try {
    console.log(`Navigating to ${url}...`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    
    const textContent = await page.evaluate(() => {
      const clone = document.body.cloneNode(true) as HTMLElement;
      const scripts = clone.querySelectorAll('script, style, noscript, svg');
      scripts.forEach(s => s.remove());
      return clone.innerText.replace(/\n\s*\n/g, '\n');
    });

    const variantData = await page.evaluate(() => {
      try {
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]'));
        for (const s of scripts) {
          if (s.innerHTML.includes('"compare_at_price"') && s.innerHTML.includes('"price"')) {
            return s.innerHTML;
          }
        }
        // @ts-ignore
        if (window.ShopifyAnalytics?.meta?.product) {
          // @ts-ignore
          return JSON.stringify(window.ShopifyAnalytics.meta.product.variants);
        }
      } catch(e) {}
      return null;
    });

    // --- FASE 1: THE MINER (Gemini 2.5 Flash-Lite via OpenRouter) ---
    // Extracción de datos técnicos estructurados
    console.log("Fase 1: Extrayendo datos técnicos con Gemini 2.5 Flash-Lite...");
    const { object: technicalData } = await timeProviderCall(
      "llm",
      "extract_technical_data",
      () =>
        generateObject({
      model: openrouter("google/gemini-2.5-flash-lite"),
      schema: PerfumeSchema,
      system: "Eres un extractor de datos ultra-preciso. Tu misión es extraer datos técnicos de perfumes sin inventar nada.",
      prompt: `Extrae la información técnica del perfume basándote en este contenido:
      
JSON Variantes: ${variantData || 'No disponible'}
Texto de la página: ${textContent}

INSTRUCCIONES:
1. VARIANTES Y PRECIOS — LEE ESTO CON MÁXIMA ATENCIÓN:
   - En Shopify los precios vienen en centavos (números grandes) — SIEMPRE dividir entre 100.
   - Campos Shopify:
       * 'price'            = lo que el cliente PAGA HOY (puede ser rebajado)
       * 'compare_at_price' = precio ORIGINAL tachado (el que estaba antes del descuento)
   - MAPEO OBLIGATORIO a los campos del schema:
       * 'precios[i]'           = precio ORIGINAL = compare_at_price / 100
                                  (si compare_at_price es null/0/igual a price → usar price / 100)
       * 'precios_descuento[i]' = precio que PAGA el cliente = price / 100
   - EJEMPLO CONCRETO: compare_at_price=69000000, price=62100000
       → precios[i] = 69000000/100 = 690000  ← el mayor (original)
       → precios_descuento[i] = 62100000/100 = 621000  ← el menor (lo que paga)
   - NUNCA pongas el mismo valor en ambos campos cuando compare_at_price > price.
   - ⛔ EXCLUSIÓN TOTAL OBLIGATORIA: NO incluyas NINGUNA variante cuyo título contenga 'tester', 'Tester', 'TESTER', 'decant', 'Decant', 'muestra' o 'sample'. Si las incluyes cometerás un error grave. Solo incluye variantes de volumen real (ej: 50 ML, 100 ML, 200 ML).
2. DISPONIBILIDAD: En Shopify busca el campo 'available' (true=Disponible, false=Agotado). En el texto, busca 'Agotado' o botones deshabilitados.
3. Genera un handle único en minúsculas con guiones.
4. El campo 'descripcion': extrae literalmente el texto descriptivo del producto que aparece en la página (el párrafo o párrafos que describen el perfume, su historia, sus notas, su personalidad). NO lo inventes. Si no hay descripción visible, déjalo vacío.
5. Retorna 4 arrays del mismo tamaño: 'variantes', 'precios', 'precios_descuento' y 'disponibilidad'.`
        })
    );

    // --- FASE 2: THE CREATIVE (DeepSeek-V3 via OpenRouter) ---
    // Paráfrasis + enriquecimiento de la descripción original
    console.log("Fase 2: Generando descripción creativa con DeepSeek-V3...");
    const hasOriginalDesc = technicalData.descripcion && technicalData.descripcion.trim().length > 20;
    const { text: creativeDescription } = await timeProviderCall(
      "llm",
      "creative_description",
      () =>
        generateText({
      model: openrouter("deepseek/deepseek-chat"),
      system: "Eres un copywriter experto en perfumería de lujo. Crea textos seductores, elegantes y persuasivos en español.",
      prompt: hasOriginalDesc
        ? `Tienes la descripción original de este perfume tomada de la página del producto:

"""
${technicalData.descripcion}
"""

Datos adicionales:
Nombre: ${technicalData.nombre}
Notas olfativas: ${technicalData.notas || "no especificadas"}
Acordes: ${technicalData.acordes || "no especificados"}
Concentración: ${technicalData.concentracion || "no especificada"}

REGLAS OBLIGATORIAS — síguelas con precisión:
1. PARÁFRASIS: reescribe la descripción original cambiando estructura de oraciones, sinónimos y orden de ideas. La similitud con el texto original NO debe superar el 20% (máximo 1 de cada 5 palabras en común en cualquier frase).
2. CONTENIDO NUEVO: al menos el 40% del texto final debe ser contenido original que NO existe en la descripción fuente — añade sensaciones, contexto de uso, evocaciones o características de las notas.
3. LONGITUD: máximo 180 palabras en total.
4. IDIOMA: español, tono sofisticado de alta perfumería.
5. FORMATO: devuelve ÚNICAMENTE el texto de la descripción. Cero notas, cero aclaraciones, cero metainformación sobre similitud léxica, porcentajes de contenido nuevo ni ningún comentario sobre el proceso de reescritura. Solo la descripción.`
        : `Redacta una descripción de marketing para este perfume:
Nombre: ${technicalData.nombre}
Notas: ${technicalData.notas || "no especificadas"}
Acordes: ${technicalData.acordes || "no especificados"}
Concentración: ${technicalData.concentracion || "no especificada"}

REGLAS: máximo 180 palabras, español sofisticado de alta perfumería, 2-3 párrafos cortos, sin títulos ni bullets.`
        })
    );

    technicalData.descripcion = creativeDescription;

    // --- FASE 3: THE RESEARCHER (Tavily o Direct Image) ---
    // Búsqueda de imágenes para que el usuario seleccione una
    // NOTA: NO procesamos las imágenes aquí. Solo retornamos las URLs tal como vienen.
    // El procesamiento (descarga, optimización, S3 upload) ocurre en /confirm-scrape
    // cuando el usuario confirma los datos.
    const possibleImages: string[] = [];

    if (directImageUrl) {
      possibleImages.push(directImageUrl);
      console.log(`Usando URL de imagen directa proporcionada: ${directImageUrl}`);
    } else if (technicalData.nombre) {
      const tavilyImages = await searchProductImages(technicalData.nombre);
      possibleImages.push(...tavilyImages);
    }

    if (possibleImages.length > 0) {
      (technicalData as any).possibleImages = possibleImages;
      console.log(`${possibleImages.length} imagen(es) disponible(s) para preview`);
    }

    (technicalData as any).sourceUrl = url;

    return technicalData;
    
  } finally {
    await browser.close();
  }
}


