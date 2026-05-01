import { chromium } from "playwright";

async function testFragrantica() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();
  
  try {
    const perfumeName = "Jean Paul Gaultier Le Beau Le Parfum";
    
    console.log(`Buscando en Google: site:fragrantica.es/perfume/ ${perfumeName}`);
    // Usamos DuckDuckGo para evitar bloqueos de Google Search (reCaptcha) en headless
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:fragrantica.es/perfume/ ${perfumeName}`)}`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
    
    // Extraer el primer enlace de fragrantica
    const fragranticaUrl = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a.result__url'));
      for (const link of links) {
        if (link.getAttribute('href')?.includes('fragrantica.es/perfume/')) {
          return link.getAttribute('href');
        }
      }
      return null;
    });

    if (!fragranticaUrl) {
      console.log("No se encontró enlace en DuckDuckGo.");
      return;
    }
    
    console.log(`URL encontrada: ${fragranticaUrl}`);
    console.log(`Navegando a Fragrantica...`);
    
    // Ir a Fragrantica
    await page.goto(fragranticaUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    
    // Extraer la imagen principal
    const imageUrl = await page.evaluate(() => {
      // Fragrantica normalmente tiene la imagen principal en un elemento con itemprop="image"
      const img = document.querySelector('img[itemprop="image"]');
      if (img) return img.getAttribute('src');
      
      // Fallback a buscar cualquier fimgs.net/mdimg/perfume-thumbs
      const images = Array.from(document.querySelectorAll('img'));
      for (const i of images) {
        const src = i.getAttribute('src');
        if (src && src.includes('fimgs.net/mdimg/perfume-thumbs/')) {
          return src;
        }
      }
      return null;
    });
    
    console.log(`Imagen extraída: ${imageUrl}`);
    
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await browser.close();
  }
}

testFragrantica();