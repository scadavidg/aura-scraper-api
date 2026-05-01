import { chromium } from "playwright";

async function checkShopifyVariants() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    await page.goto("https://disfragancias.com/products/jean-paul-gaultier-le-beau-le-parfum", { waitUntil: "domcontentloaded" });
    
    // Extrayendo el contenido de los scripts para ver si la info de variantes está ahí
    const variants = await page.evaluate(() => {
      // @ts-ignore
      return window.ShopifyAnalytics?.meta?.product?.variants;
    });

    console.log(JSON.stringify(variants, null, 2));
    
  } finally {
    await browser.close();
  }
}

checkShopifyVariants();