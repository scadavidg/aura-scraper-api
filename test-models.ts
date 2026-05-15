#!/usr/bin/env node
/**
 * Model Comparison Test
 *
 * Scrape target URL with different models, compare results, save to Firestore.
 *
 * Run: npx ts-node test-models.ts
 */

import { chromium } from "playwright";
import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import dotenv from "dotenv";
// Firebase imports (commented out - enable if needed for Firestore logging)
// import {
//   initializeApp,
//   getApps,
//   FirebaseApp,
// } from "firebase/app";
// import {
//   getFirestore,
//   Firestore,
//   collection,
//   addDoc,
//   Timestamp,
// } from "firebase/firestore";

dotenv.config();

// Firebase init (commented out - enable if needed)
// const firebaseConfig = {
//   apiKey: process.env.FIREBASE_API_KEY || process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
//   authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
//   projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
//   storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
//   messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
//   appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
// };

let firestore: any = null;

// try {
//   const app =
//     getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
//   firestore = getFirestore(app);
//   console.log("✅ Firebase initialized");
// } catch (e) {
//   console.warn("⚠️  Firebase not available. Results won't be saved to Firestore.");
// }

// Models to test
const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPEN_ROUTER_API_KEY,
});

// Schema (same as scraper)
const PerfumeSchema = z.object({
  nombre: z.string(),
  variantes: z.array(z.string()),
  precios: z.array(z.number()),
  precios_descuento: z.array(z.number()),
  disponibilidad: z.array(z.boolean()),
  notas: z.string(),
  acordes: z.string(),
  handle: z.string(),
  descripcion: z.string().default(""),
  possibleImages: z.array(z.string()).default([]),
});

type PerfumeData = z.infer<typeof PerfumeSchema>;

interface TestResult {
  model: string;
  provider: string;
  url: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  success: boolean;
  error?: string;
  data?: PerfumeData;
  resultQuality?: "excellent" | "good" | "acceptable" | "poor";
  notes?: string;
}

async function scrapePage(
  url: string
): Promise<{ textContent: string; variantData: string | null }> {
  console.log(`\n🌐 Fetching page: ${url}`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);

    const textContent = await page.evaluate(() => {
      const clone = document.body.cloneNode(true) as HTMLElement;
      const scripts = clone.querySelectorAll("script, style, noscript, svg");
      scripts.forEach((s) => s.remove());
      return clone.innerText.replace(/\n\s*\n/g, "\n");
    });

    const variantData = await page.evaluate(() => {
      try {
        const scripts = Array.from(
          document.querySelectorAll('script[type="application/json"]')
        );
        for (const s of scripts) {
          if (
            s.innerHTML.includes('"compare_at_price"') &&
            s.innerHTML.includes('"price"')
          ) {
            return s.innerHTML;
          }
        }
      } catch (e) {}
      return null;
    });

    await browser.close();
    return { textContent, variantData };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function testModel(
  modelName: string,
  provider: string,
  pageData: { textContent: string; variantData: string | null },
  url: string
): Promise<TestResult> {
  const startTime = Date.now();
  const result: TestResult = {
    model: modelName,
    provider,
    url,
    startTime,
    endTime: 0,
    durationMs: 0,
    success: false,
  };

  try {
    console.log(`\n🔬 Testing: ${modelName} (${provider})`);

    let aiModel: any;

    if (modelName === "gemini-2.5-flash-lite-direct") {
      // Direct Google API (requires GOOGLE_GENERATIVE_AI_API_KEY)
      aiModel = google("gemini-2.5-flash-lite");
    } else if (
      modelName === "google/gemini-2.5-flash-lite" ||
      modelName === "deepseek/deepseek-chat" ||
      modelName === "qwen/qwen-max" ||
      modelName === "anthropic/claude-3.5-sonnet"
    ) {
      aiModel = openrouter(modelName);
    } else {
      throw new Error(`Unknown model: ${modelName}`);
    }

    const { object: technicalData } = await generateObject({
      model: aiModel,
      schema: PerfumeSchema,
      system:
        "Eres un extractor de datos ultra-preciso. Tu misión es extraer datos técnicos de perfumes sin inventar nada.",
      prompt: `Extrae la información técnica del perfume basándote en este contenido:

JSON Variantes: ${pageData.variantData || "No disponible"}
Texto de la página: ${pageData.textContent}

INSTRUCCIONES:
1. VARIANTES Y PRECIOS:
   - En Shopify los precios vienen en centavos — SIEMPRE dividir entre 100.
   - 'price' = precio actual que paga el cliente
   - 'compare_at_price' = precio original (si hay descuento)
   - REGLA CRÍTICA: Excluye CUALQUIER variante con 'decant', 'tester' o 'TESTER'
2. DISPONIBILIDAD: Busca campo 'available' (true=Disponible, false=Agotado)
3. Genera un handle único en minúsculas con guiones
4. El campo 'descripcion' déjalo como string vacío
5. Retorna 4 arrays del mismo tamaño`,
    });

    result.success = true;
    result.data = technicalData;
    console.log(`✅ Extraction successful`);
    console.log(`   - Nombre: ${technicalData.nombre}`);
    console.log(`   - Variantes: ${technicalData.variantes.length}`);
    console.log(`   - Precios: ${technicalData.precios.join(", ")}`);
  } catch (error: any) {
    result.success = false;
    result.error = error.message;
    console.error(`❌ Error: ${error.message}`);
  }

  result.endTime = Date.now();
  result.durationMs = result.endTime - result.startTime;

  return result;
}

// Firestore save function (commented out - enable if needed)
// async function saveToFirestore(results: TestResult[], url: string) {
//   if (!firestore) {
//     console.log("\n⚠️  Firestore not available. Skipping save.");
//     return;
//   }
//
//   try {
//     console.log("\n💾 Saving results to Firestore...");
//     const docRef = await addDoc(collection(firestore, "scraper_experiments"), {
//       url,
//       timestamp: Timestamp.now(),
//       results: results.map((r) => ({
//         ...r,
//         startTime: new Date(r.startTime).toISOString(),
//         endTime: new Date(r.endTime).toISOString(),
//       })),
//     });
//     console.log(`✅ Saved to scraper_experiments/${docRef.id}`);
//   } catch (error: any) {
//     console.error("❌ Failed to save to Firestore:", error.message);
//   }
// }

function printSummary(results: TestResult[]) {
  console.log("\n" + "=".repeat(80));
  console.log("📊 TEST RESULTS SUMMARY");
  console.log("=".repeat(80));

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  console.log(`\n✅ Successful: ${successful.length}/${results.length}`);
  successful.forEach((r) => {
    console.log(
      `   ${r.model} (${r.provider}) - ${r.durationMs}ms - Variantes: ${r.data?.variantes.length || 0}`
    );
  });

  if (failed.length > 0) {
    console.log(`\n❌ Failed: ${failed.length}/${results.length}`);
    failed.forEach((r) => {
      console.log(`   ${r.model} (${r.provider}) - ${r.error}`);
    });
  }

  console.log("\n📈 Cost Estimate (per 1000 requests via OpenRouter):");
  console.log("   - Gemini 2.5 Flash-Lite (OR): ~$0.15");
  console.log("   - DeepSeek Chat (OR): ~$0.14");
  console.log("   - Qwen Max (OR): ~$0.55");
  console.log("   - Claude 3.5 Sonnet (OR): ~$3.00");
  console.log("\n💡 Note: Gemini via OpenRouter avoids Google API key issues!");
}

async function main() {
  const url =
    "https://disfragancias.com/products/carolina-herrera-ch-la-bomba";

  console.log("🧪 Model Comparison Test");
  console.log(`📍 URL: ${url}`);
  console.log("=".repeat(80));

  try {
    // Fetch page once
    const pageData = await scrapePage(url);
    console.log(`✅ Page fetched (text: ${pageData.textContent.length} chars)`);

    // Test all models
    const modelsToTest = [
      { name: "google/gemini-2.5-flash-lite", provider: "OpenRouter/Google" },
      { name: "deepseek/deepseek-chat", provider: "OpenRouter/DeepSeek" },
      { name: "qwen/qwen-max", provider: "OpenRouter/Qwen" },
      {
        name: "anthropic/claude-3.5-sonnet",
        provider: "OpenRouter/Anthropic",
      },
    ];

    const results: TestResult[] = [];

    for (const { name, provider } of modelsToTest) {
      const result = await testModel(name, provider, pageData, url);
      results.push(result);

      // Small delay between requests
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Print summary
    printSummary(results);

    // Save to Firestore (commented out - enable if needed)
    // await saveToFirestore(results, url);

    console.log("\n✅ Test completed");
  } catch (error: any) {
    console.error("❌ Fatal error:", error.message);
    process.exit(1);
  }
}

main();
