import { chromium } from "playwright";
import fs from "fs";

async function dumpText() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    await page.goto("https://disfragancias.com/products/jean-paul-gaultier-le-beau-le-parfum", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);
    
    const textContent = await page.evaluate(() => {
      const clone = document.body.cloneNode(true) as HTMLElement;
      const scripts = clone.querySelectorAll('script, style, noscript, svg');
      scripts.forEach(s => s.remove());
      return clone.innerText.replace(/\n\s*\n/g, '\n'); 
    });

    fs.writeFileSync("page-text.txt", textContent);
    console.log("Text dumped to page-text.txt. Length:", textContent.length);
    
  } finally {
    await browser.close();
  }
}

dumpText();