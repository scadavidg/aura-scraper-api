import { chromium } from "playwright";

async function checkPriceData() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    await page.goto("https://disfragancias.com/products/jean-paul-gaultier-le-beau-le-parfum", { waitUntil: "domcontentloaded" });
    
    // Extrayendo el contenido de la página para buscar el número 460000 o 460.000
    const bodyText = await page.evaluate(() => document.body.innerHTML);
    const index = bodyText.indexOf("460");
    if (index !== -1) {
      console.log("Encontrado '460' en HTML:", bodyText.substring(Math.max(0, index - 200), index + 200));
    } else {
      console.log("No se encontró 460 en el HTML de la página.");
    }
    
    const index2 = bodyText.indexOf("660");
    if (index2 !== -1) {
      console.log("Encontrado '660' en HTML:", bodyText.substring(Math.max(0, index2 - 200), index2 + 200));
    }
  } finally {
    await browser.close();
  }
}

checkPriceData();