import { generateObject } from 'ai';
import { google } from '@ai-sdk/google';
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

async function run() {
  try {
    const result = await generateObject({
      model: google('gemini-2.5-flash', { useSearchGrounding: true }),
      schema: z.object({ url: z.string() }),
      prompt: 'Busca en la web el perfume "Jean Paul Gaultier Le Beau Le Parfum" específicamente dentro del sitio web fragrantica.es. Necesito que me devuelvas LA URL EXACTA de la página del producto en ese sitio web. Debe verse como https://www.fragrantica.es/perfume/...',
    });
    console.log("Resultado de Gemini con Grounding:", result.object);
  } catch (error) {
    console.error("Error:", error);
  }
}

run();