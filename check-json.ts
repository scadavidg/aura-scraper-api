import { chromium } from "playwright";

async function getProductJson() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    await page.goto("https://disfragancias.com/products/jean-paul-gaultier-le-beau-le-parfum", { waitUntil: "domcontentloaded" });
    
    const productJson = await page.evaluate(() => {
      // Intentar encontrar scripts de producto
      const scripts = Array.from(document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]'));
      for (const s of scripts) {
        if (s.innerHTML.includes('"compare_at_price"')) {
          return s.innerHTML;
        }
      }
      
      // Buscar en variables globales
      // @ts-ignore
      if (window.meta && window.meta.product) return JSON.stringify(window.meta.product);
      return null;
    });

    console.log(productJson ? productJson.substring(0, 1000) : "No se encontró JSON completo");
    
  } finally {
    await browser.close();
  }
}

getProductJson();