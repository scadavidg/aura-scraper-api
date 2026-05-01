import { chromium } from "playwright";

async function scrapeFragranticaImage(url: string) {
  const browser = await chromium.launch({ headless: true });
  // Usamos un user-agent realista
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();
  
  try {
    console.log(`Navegando a Fragrantica: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    
    // Esperamos a que cargue la imagen
    await page.waitForTimeout(3000);
    
    const imageUrl = await page.evaluate(() => {
      // Prioridad 1: itemprop image
      const img = document.querySelector('img[itemprop="image"]') as HTMLImageElement;
      if (img && img.src) return img.src;
      
      // Prioridad 2: Buscar cualquier imagen que coincida con fimgs.net
      const images = Array.from(document.querySelectorAll('img'));
      for (const i of images) {
        if (i.src && i.src.includes('fimgs.net/mdimg/perfume-thumbs/')) {
          return i.src;
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

scrapeFragranticaImage("https://www.fragrantica.es/perfume/Jean-Paul-Gaultier/Le-Beau-Le-Parfum-74317.html");