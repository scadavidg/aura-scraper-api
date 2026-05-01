import dotenv from "dotenv";
import { scrapePerfumePage } from "./src/scraper";

dotenv.config();

const url = "https://disfragancias.com/products/lattafa-yara?variant=47648860602675";

async function run() {
  try {
    console.log("--- Test 1: Búsqueda Automática (Tavily) ---");
    console.log("Starting test for:", url);
    const data1 = await scrapePerfumePage(url);
    console.log("Success! Data 1 (Auto Image):", JSON.stringify(data1, null, 2));

    console.log("\n--- Test 2: URL de Imagen Directa ---");
    const directImg = "https://fimgs.net/mdimg/perfume/o.95752.jpg";
    const data2 = await scrapePerfumePage(url, directImg);
    console.log("Success! Data 2 (Direct Image):", JSON.stringify(data2, null, 2));
    
  } catch (error) {
    console.error("Scraping failed with error:");
    console.error(error);
  }
}

run();