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
import { validateAndOptimizeImageData, processAndUploadImage } from "./image-processor";
import { authMiddleware, isValidToken, registerToken } from "./auth";

dotenv.config();

// ── API Test Push ──────────────────────────────────────────────────────────
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

    // Validate image is present - required field
    if (!confirmedData.image || confirmedData.image.trim() === "") {
      return reply.status(400).send({
        error: "Image is required",
        message: "A product must have an image. Please upload or select an image before confirming.",
      });
    }

    // Process and optimize image if provided
    if (confirmedData.image) {
      try {
        const originalImage = confirmedData.image;
        if (confirmedData.image.startsWith("data:")) {
          // Case 1: User uploaded image as data-uri
          server.log.info(`Optimizing user-uploaded image for: ${confirmedData.nombre}`);
          const imageResult = await validateAndOptimizeImageData(
            confirmedData.image,
            confirmedData.nombre
          );
          confirmedData.image = imageResult.dataUri;
          confirmedData.sourceImageUrl = "manual upload";

          server.log.info(
            `Image optimization: ${imageResult.originalSizeKB}KB → ${imageResult.optimizedSizeKB}KB`
          );
        } else {
          // Case 2: Image URL from Tavily search or direct URL - process and upload to S3
          server.log.info(`Processing and uploading image URL for: ${confirmedData.nombre}`);
          const s3Url = await processAndUploadImage(
            confirmedData.image,
            confirmedData.nombre
          );
          confirmedData.image = s3Url;
          confirmedData.sourceImageUrl = originalImage;

          server.log.info(`Image uploaded to S3: ${s3Url}`);
        }
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

    // Validate image exists (final safety check)
    if (!session.confirmedData.image || session.confirmedData.image.trim() === "") {
      return reply.status(400).send({
        error: "Product image is missing",
        message: "Cannot create product without an image.",
      });
    }

    const useNewEndpoint = process.env.USE_NEW_IMPORT_ENDPOINT === "true";
    let response;

    if (useNewEndpoint) {
      // NEW: Use /store/products/import
      // Filter out possibleImages as it's not needed by the backend
      const { possibleImages, ...perfumeData } = session.confirmedData;
      
      const medusaUrl = `${process.env.MEDUSA_BACKEND_URL}/store/products/import`;
      server.log.info(`Using new import endpoint: ${medusaUrl}`);
      
      response = await fetch(medusaUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-publishable-api-key": process.env.MEDUSA_PUBLISHABLE_API_KEY || "",
          "x-price-manager-key": process.env.PRICE_MANAGER_API_KEY || "",
        },
        body: JSON.stringify({ perfumes: [perfumeData] }),
      });
    } else {
      // OLD: Use /store/price-manager/products (legacy batch)
      const medusaProduct = mapPerfumeToMedusaProduct(session.confirmedData);
      const medusaUrl = `${process.env.MEDUSA_BACKEND_URL}/store/price-manager/products`;
      server.log.info(`Using legacy endpoint: ${medusaUrl}`);

      response = await fetch(medusaUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-publishable-api-key": process.env.MEDUSA_PUBLISHABLE_API_KEY || "",
          "x-price-manager-key": process.env.PRICE_MANAGER_API_KEY || "",
        },
        body: JSON.stringify(medusaProduct),
      });
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      server.log.error("Medusa error:", errorData);
      return reply.status(502).send({
        error: "Failed to create product in Medusa",
        details: errorData,
      });
    }

    const createdProduct = await response.json();

    // Clean up session
    deleteSession(sessionId);

    if (useNewEndpoint) {
      const result = createdProduct.results?.[0];
      server.log.info(
        `Product processed via new import: ${result?.handle} (${result?.action})`
      );

      return reply.status(201).send({
        success: true,
        productId: result?.product_id,
        action: result?.action,
        message: `Product ${result?.action} successfully via new import`,
      });
    } else {
      server.log.info(
        `Product created successfully via legacy: ${createdProduct.product?.id || createdProduct.id}`
      );

      return reply.status(201).send({
        success: true,
        productId: createdProduct.product?.id || createdProduct.id,
        message: "Product created successfully via legacy",
      });
    }
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