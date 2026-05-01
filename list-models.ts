import { google } from "@ai-sdk/google";
import dotenv from "dotenv";

dotenv.config();

async function listModels() {
  try {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await response.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Error listing models:", error);
  }
}

listModels();
