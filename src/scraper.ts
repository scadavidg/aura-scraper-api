import { chromium } from "playwright";
import { generateObject, generateText } from "ai";
import { google } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { tavily } from "@tavily/core";
import { z } from "zod";
import dotenv from "dotenv";
import { PerfumeSchema } from "./schema";
import { processAndUploadImage } from "./image-processor";

dotenv.config();

// Configuración de Clientes
const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPEN_ROUTER_API_KEY,
});

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

async function getFragranticaImages(perfumeName: string): Promise<string[]> {
  console.log(`Buscando imágenes para: ${perfumeName} con Tavily Researcher...`);
  try {
    // Usar Tavily para buscar imágenes directamente
    const response = await tvly.search(`site:fragrantica.es perfume ${perfumeName}`, {
      searchDepth: "advanced",
      includeImages: true,
      maxResults: 10
    });

    // Extraer URLs de imágenes
    const images = response.images as any[];
    const imageUrls: string[] = [];

    for (const img of images) {
      const url = typeof img === 'string' ? img : img?.url;
      if (url && imageUrls.length < 3) {
        imageUrls.push(url);
      }
    }

    if (imageUrls.length > 0) {
      console.log(`${imageUrls.length} imagen(es) encontrada(s) vía Tavily`);
      return imageUrls;
    }

  } catch (error) {
    console.error("Error obteniendo imágenes con Tavily:", error);
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

    // --- FASE 1: THE MINER (Gemini 2.5 Flash-Lite) ---
    // Extracción de datos técnicos estructurados
    console.log("Fase 1: Extrayendo datos técnicos con Gemini 2.5 Flash-Lite...");
    const { object: technicalData } = await generateObject({
      model: google("gemini-2.5-flash-lite"),
      schema: PerfumeSchema,
      system: "Eres un extractor de datos ultra-preciso. Tu misión es extraer datos técnicos de perfumes sin inventar nada.",
      prompt: `Extrae la información técnica del perfume basándote en este contenido:
      
JSON Variantes: ${variantData || 'No disponible'}
Texto de la página: ${textContent}

INSTRUCCIONES:
1. VARIANTES Y PRECIOS (leer con cuidado):
   - En Shopify los precios vienen en centavos — SIEMPRE dividir entre 100.
   - 'price' = precio actual que paga el cliente (el MENOR cuando hay descuento).
   - 'compare_at_price' = precio original tachado (el MAYOR, precio sin descuento).
   - Regla de mapeo:
       * Si compare_at_price > price → hay descuento:
           precios[i]           = compare_at_price / 100  (precio normal, el mayor)
           precios_descuento[i] = price / 100             (precio rebajado, el menor)
       * Si compare_at_price == price, es null o es 0 → sin descuento:
           precios[i]           = price / 100
           precios_descuento[i] = price / 100
   - REGLA CRÍTICA: Excluye CUALQUIER variante con las palabras 'decant', 'Decant', 'tester', 'Tester' o 'TESTER'.
2. DISPONIBILIDAD: En Shopify busca el campo 'available' (true=Disponible, false=Agotado). En el texto, busca 'Agotado' o botones deshabilitados.
3. Genera un handle único en minúsculas con guiones.
4. El campo 'descripcion' déjalo como string vacío por ahora.
5. Retorna 4 arrays del mismo tamaño: 'variantes', 'precios', 'precios_descuento' y 'disponibilidad'.`
    });

    // --- FASE 2: THE CREATIVE (DeepSeek-V3 via OpenRouter) ---
    // Generación de descripción persuasiva de marketing
    console.log("Fase 2: Generando descripción creativa con DeepSeek-V3...");
    const { text: creativeDescription } = await generateText({
      model: openrouter("deepseek/deepseek-chat"),
      system: "Eres un copywriter experto en perfumería de lujo. Crea textos seductores, elegantes y persuasivos.",
      prompt: `Basándote en estos datos del perfume:
Nombre: ${technicalData.nombre}
Notas: ${technicalData.notas}
Acordes: ${technicalData.acordes}

Redacta una descripción de marketing de 2 a 3 párrafos cortos. Debe ser sofisticada, evocar emociones y resaltar por qué este perfume es una joya. Evita sonar genérico, usa lenguaje de alta perfumería.`
    });

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
      const tavilyImages = await getFragranticaImages(technicalData.nombre);
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


