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

async function getFragranticaImage(perfumeName: string): Promise<string | undefined> {
  console.log(`Buscando imagen para: ${perfumeName} con Tavily Researcher...`);
  try {
    // Usar Tavily para buscar imágenes directamente
    const response = await tvly.search(`site:fragrantica.es perfume ${perfumeName}`, {
      searchDepth: "advanced",
      includeImages: true,
      maxResults: 5
    });
    
    // Tavily retorna un array de imágenes. Buscamos la que parezca más relevante de Fragrantica.
    // Priorizamos imágenes que vengan de fimgs.net (servidor de imágenes de Fragrantica)
    const fragranticaImg = response.images.find(img => 
      typeof img === 'string' ? img.includes('fimgs.net') : (img as any).url?.includes('fimgs.net')
    );

    const imageUrl = typeof fragranticaImg === 'string' ? fragranticaImg : (fragranticaImg as any)?.url;

    if (imageUrl) {
      console.log(`Imagen encontrada vía Tavily: ${imageUrl}`);
      return imageUrl;
    }

    // Fallback: primera imagen que encuentre Tavily si no hay de fimgs.net
    if (response.images.length > 0) {
      const firstImg = response.images[0];
      return typeof firstImg === 'string' ? firstImg : (firstImg as any)?.url;
    }

  } catch (error) {
    console.error("Error obteniendo imagen con Tavily:", error);
  }
  return undefined;
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
1. VARIANTES Y PRECIOS: Extrae variantes, precios (dividir entre 100 si es Shopify) y notas. 
   - REGLA CRÍTICA: Excluye explícitamente CUALQUIER variante que contenga las palabras 'decant', 'Decant', 'tester', 'Tester' o 'TESTER'. Si una variante es un decant o un tester, no la incluyas ni a ella ni a su precio ni a su disponibilidad. Ejemplos a ignorar: "100 ML (Tester)", "Decant 5ml", "TESTER 100ML".
2. DISPONIBILIDAD: Determina si cada variante está 'Disponible' o 'Agotado'. En Shopify, busca el campo 'available' (true=Disponible, false=Agotado). En el texto, busca menciones de 'Agotado' o botones deshabilitados.
3. Genera un handle único.
4. El campo 'descripcion' déjalo como un string vacío por ahora.
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
    // Búsqueda de imagen de alta calidad o uso de URL directa
    if (technicalData.nombre) {
      let bestImageUrl = directImageUrl;

      if (!bestImageUrl) {
        bestImageUrl = await getFragranticaImage(technicalData.nombre);
      } else {
        console.log(`Usando URL de imagen directa proporcionada: ${bestImageUrl}`);
      }
      
      if (bestImageUrl) {
        try {
          const s3Url = await processAndUploadImage(bestImageUrl, technicalData.nombre);
          technicalData.image = s3Url;
        } catch (err) {
          console.error("Error en pipeline de imagen, conservando URL original.", err);
          technicalData.image = bestImageUrl;
        }
      }
    }

    return technicalData;
    
  } finally {
    await browser.close();
  }
}

