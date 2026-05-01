import fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import path from "path";
import dotenv from "dotenv";
import { scrapePerfumePage } from "./scraper";
import { PerfumeSchema, Perfume } from "./schema";
import {
  createSession,
  getSession,
  updateSessionConfirmation,
  deleteSession,
} from "./session-store";
import { mapPerfumeToMedusaProduct } from "./medusa-mapper";
import { validateAndOptimizeImageData } from "./image-processor";
import { authMiddleware, isValidToken, registerToken } from "./auth";

dotenv.config();

// Register token from env after dotenv is configured
if (process.env.SCRAPER_API_TOKEN) {
  registerToken(process.env.SCRAPER_API_TOKEN, "default");
}

const server = fastify({ logger: true });

// ── CORS Configuration ──────────────────────────────────────────────────────
server.register(fastifyCors, {
  origin: process.env.CORS_ORIGIN || ["http://localhost:3001", "http://localhost:3000"],
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
});

// Register static files to serve temporary images
server.register(fastifyStatic, {
  root: path.join(process.cwd(), "temp_images"),
  prefix: "/temp/",
});

// ── POST /scrape ──────────────────────────────────────────────────────────
server.post("/scrape", async (request, reply) => {
  try {
    const { url, imageUrl } = request.body as { url: string; imageUrl?: string };

    if (!url) {
      return reply.status(400).send({ error: "URL is required" });
    }

    server.log.info(`Scraping started for: ${url}${imageUrl ? ` with direct image: ${imageUrl}` : ''}`);
    const scrapedData = await scrapePerfumePage(url, imageUrl);

    // Create session to track this scrape
    const sessionId = createSession(scrapedData);

    return reply.status(200).send({
      sessionId,
      data: scrapedData,
    });
  } catch (error) {
    server.log.error(error);
    return reply.status(500).send({ error: "Failed to scrape the page" });
  }
});

// ── POST /confirm-scrape ──────────────────────────────────────────────────
server.post("/confirm-scrape", async (request, reply) => {
  try {
    // Auth check
    if (!isValidToken(request.headers.authorization?.replace("Bearer ", ""))) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Missing or invalid API token",
      });
    }

    const { sessionId, data } = request.body as {
      sessionId: string;
      data: Perfume;
    };

    if (!sessionId || !data) {
      return reply.status(400).send({
        error: "sessionId and data are required",
      });
    }

    const session = getSession(sessionId);
    if (!session) {
      return reply.status(404).send({
        error: "Session not found or expired",
      });
    }

    // Validate data against schema
    const validationResult = PerfumeSchema.safeParse(data);
    if (!validationResult.success) {
      return reply.status(400).send({
        error: "Invalid data",
        details: validationResult.error.issues,
      });
    }

    const confirmedData = validationResult.data;

    // Process and optimize image if provided
    if (confirmedData.image && confirmedData.image.startsWith("data:")) {
      try {
        server.log.info(`Optimizing image for: ${confirmedData.nombre}`);
        const imageResult = await validateAndOptimizeImageData(
          confirmedData.image,
          confirmedData.nombre
        );
        confirmedData.image = imageResult.dataUri;

        server.log.info(
          `Image optimization: ${imageResult.originalSizeKB}KB → ${imageResult.optimizedSizeKB}KB`
        );
      } catch (imgError: any) {
        return reply.status(400).send({
          error: "Image processing failed",
          details: imgError.message,
        });
      }
    }

    // Update session with confirmed data
    const updated = updateSessionConfirmation(sessionId, confirmedData);
    if (!updated) {
      return reply.status(404).send({
        error: "Failed to update session",
      });
    }

    server.log.info(`Scrape session ${sessionId} confirmed`);

    return reply.status(200).send({
      success: true,
      sessionId,
      validatedData: confirmedData,
    });
  } catch (error) {
    server.log.error(error);
    return reply.status(500).send({ error: "Failed to confirm scrape" });
  }
});

// ── POST /create-product ──────────────────────────────────────────────────
server.post("/create-product", async (request, reply) => {
  try {
    // Auth check
    if (!isValidToken(request.headers.authorization?.replace("Bearer ", ""))) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Missing or invalid API token",
      });
    }

    const { sessionId } = request.body as { sessionId: string };

    if (!sessionId) {
      return reply.status(400).send({
        error: "sessionId is required",
      });
    }

    const session = getSession(sessionId);
    if (!session) {
      return reply.status(404).send({
        error: "Session not found or expired",
      });
    }

    if (!session.confirmedData) {
      return reply.status(400).send({
        error: "No confirmed data in session. Call /confirm-scrape first.",
      });
    }

    // Map to Medusa format
    const medusaProduct = mapPerfumeToMedusaProduct(session.confirmedData);

    // Call Medusa backend
    const medusaUrl = `${process.env.MEDUSA_BACKEND_URL}/store/price-manager/products`;
    const medusaResponse = await fetch(medusaUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-publishable-api-key": process.env.MEDUSA_PUBLISHABLE_API_KEY || "",
        "x-price-manager-key": process.env.PRICE_MANAGER_API_KEY || "",
      },
      body: JSON.stringify(medusaProduct),
    });

    if (!medusaResponse.ok) {
      const errorData = await medusaResponse.json().catch(() => ({}));
      server.log.error("Medusa error:", errorData);
      return reply.status(502).send({
        error: "Failed to create product in Medusa",
        details: errorData,
      });
    }

    const createdProduct = await medusaResponse.json();

    // Clean up session
    deleteSession(sessionId);

    server.log.info(
      `Product created successfully: ${createdProduct.product?.id || createdProduct.id}`
    );

    return reply.status(201).send({
      success: true,
      productId: createdProduct.product?.id || createdProduct.id,
      message: "Product created successfully",
    });
  } catch (error) {
    server.log.error(error);
    return reply.status(500).send({ error: "Failed to create product" });
  }
});

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || "3000", 10);
    await server.listen({ port, host: "0.0.0.0" });
    console.log(`Server listening on http://localhost:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();