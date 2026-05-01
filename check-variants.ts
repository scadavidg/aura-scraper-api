import { chromium } from "playwright";

async function checkVariants() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    await page.goto("https://disfragancias.com/products/jean-paul-gaultier-le-beau-le-parfum", { waitUntil: "domcontentloaded" });
    
    // Extrayendo el contenido de los scripts para ver si la info de variantes está ahí
    const scripts = await page.evaluate(() => {
      const scriptTags = Array.from(document.querySelectorAll('script'));
      return scriptTags
        .map(s => s.innerText)
        .filter(text => text.includes('variant') || text.includes('price'))
        .slice(0, 5); // Tomamos los primeros 5 que coincidan para no saturar la salida
    });

    console.log("Scripts encontrados con información de variantes/precios:");
    scripts.forEach((script, i) => {
      console.log(`\n--- Script ${i + 1} ---`);
      console.log(script.substring(0, 1000) + "...");
    });
    
  } finally {
    await browser.close();
  }
}

checkVariants();