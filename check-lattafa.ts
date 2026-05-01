import { chromium } from "playwright";

async function checkLattafa() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    await page.goto("https://disfragancias.com/products/lattafa-yara?variant=47648860602675", { waitUntil: "domcontentloaded" });
    
    const variantData = await page.evaluate(() => {
      try {
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]'));
        for (const s of scripts) {
          if (s.innerHTML.includes('"compare_at_price"') && s.innerHTML.includes('"price"')) {
            return s.innerHTML;
          }
        }
        
        // @ts-ignore
        if (window.ShopifyAnalytics && window.ShopifyAnalytics.meta && window.ShopifyAnalytics.meta.product) {
          // @ts-ignore
          return JSON.stringify(window.ShopifyAnalytics.meta.product.variants);
        }
      } catch(e) {}
      return null;
    });

    console.log("Variant Data Length:", variantData ? variantData.length : "Not Found");
    if (variantData) {
       console.log("Snippet:", variantData.substring(0, 500));
    }
  } finally {
    await browser.close();
  }
}

checkLattafa();