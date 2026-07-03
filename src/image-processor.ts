import sharp from 'sharp';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import { logger } from './logger';

// Initialize S3 Client
const s3Client = new S3Client({
  region: process.env.S3_REGION || 'us-east-2',
  endpoint: process.env.S3_ENDPOINT ? `https://${process.env.S3_ENDPOINT}` : undefined,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  },
});

const OUTPUT_SIZE = 1080;
const TARGET_MAX_BYTES = 100 * 1024; // 100 KB
const TEMP_DIR = path.join(process.cwd(), 'temp_images');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "");
}

// \u2500\u2500 Bounding-box detection \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface BoundingBox { top: number; left: number; width: number; height: number; }

/**
 * Scans raw RGBA pixel data and returns the bounding box of non-background pixels.
 *
 * Offset math:
 *   Pixel (x,y) \u2192 byte index (y * imgWidth + x) * 4 in the flat RGBA buffer.
 *   We track (minX, minY, maxX, maxY) across all "product" pixels, then apply
 *   a small fractional padding before clamping to image bounds.
 */
function detectBoundingBox(
  data: Buffer,
  imgWidth: number,
  imgHeight: number,
  threshold: number,
  bboxPadding: number,
): BoundingBox {
  let minX = imgWidth, maxX = 0;
  let minY = imgHeight, maxY = 0;

  for (let y = 0; y < imgHeight; y++) {
    for (let x = 0; x < imgWidth; x++) {
      const i = (y * imgWidth + x) * 4;
      if (data[i + 3] < 128) continue; // transparent \u2014 skip
      // White-background assumption: product is darker than (255 \u2212 threshold)
      if (data[i] < 255 - threshold || data[i + 1] < 255 - threshold || data[i + 2] < 255 - threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (minX > maxX || minY > maxY) return { top: 0, left: 0, width: imgWidth, height: imgHeight };

  const padX = Math.round((maxX - minX) * bboxPadding);
  const padY = Math.round((maxY - minY) * bboxPadding);
  const top    = Math.max(0, minY - padY);
  const left   = Math.max(0, minX - padX);
  const bottom = Math.min(imgHeight - 1, maxY + padY);
  const right  = Math.min(imgWidth  - 1, maxX + padX);
  return { top, left, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * Normalises a product photo to a 1080\u00d71080 white canvas:
 *   1. Detects the product bounding box via pixel threshold scan.
 *   2. Crops to the bbox.
 *   3. Scales so the product HEIGHT = 71 % of the canvas (\u224814.5 % margin each side).
 *      Width scales proportionally (no deformation). Lanczos3 interpolation.
 *   4. Centers on the canvas:
 *      offsetX = \u230a(1080 \u2212 scaledWidth)  / 2\u230b
 *      offsetY = \u230a(1080 \u2212 scaledHeight) / 2\u230b
 * Returns a PNG buffer ready for WebP conversion.
 */
async function processToSquare(imageBuffer: Buffer): Promise<Buffer> {
  const { data: rawData, info } = await sharp(imageBuffer)
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const bbox = detectBoundingBox(rawData, info.width, info.height, 20, 0.02);

  const cropped = await sharp(imageBuffer)
    .extract({ left: bbox.left, top: bbox.top, width: bbox.width, height: bbox.height })
    .toBuffer();

  const scaledHeight = Math.round(OUTPUT_SIZE * 0.71);
  const scaledWidth  = Math.round(scaledHeight * (bbox.width / bbox.height));

  const resized = await sharp(cropped)
    .resize(scaledWidth, scaledHeight, { kernel: sharp.kernel.lanczos3, fit: 'fill' })
    .toBuffer();

  const offsetX = Math.floor((OUTPUT_SIZE - scaledWidth)  / 2);
  const offsetY = Math.floor((OUTPUT_SIZE - scaledHeight) / 2);

  return sharp({
    create: { width: OUTPUT_SIZE, height: OUTPUT_SIZE, channels: 3,
              background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([{ input: resized, left: offsetX, top: offsetY }])
    .png()
    .toBuffer();
}

/**
 * Compresses a PNG/WebP buffer to WebP \u2264 TARGET_MAX_BYTES using binary-search quality.
 * More precise than a fixed step-down loop \u2014 maximises quality within the size limit.
 */
async function convertToOptimizedWebP(imageBuffer: Buffer): Promise<Buffer> {
  // Fast path: try quality 80 first
  let result = await sharp(imageBuffer).webp({ quality: 80, effort: 6 }).toBuffer();
  if (result.length <= TARGET_MAX_BYTES) return result;

  // Binary search between quality 30 and 79
  let lo = 30, hi = 79;
  let best = result;
  for (let i = 0; i < 10 && lo <= hi; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = await sharp(imageBuffer).webp({ quality: mid, effort: 6 }).toBuffer();
    if (candidate.length <= TARGET_MAX_BYTES) {
      best = candidate;
      lo = mid + 1; // try higher quality
    } else {
      hi = mid - 1; // too big, go lower
    }
  }
  return best;
}

/**
 * Downloads, processes, and uploads an image to S3 or saves locally based on feature flag.
 */
export async function processAndUploadImage(imageUrl: string, productName: string): Promise<string> {
  if (!imageUrl) throw new Error("Image URL is required for processing.");

  const enableS3 = process.env.ENABLE_S3_UPLOAD === 'true';

  try {
    console.log(`Downloading image from: ${imageUrl}`);
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);
    
    const arrayBuffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);

    console.log(`Processing image for: ${productName}`);
    
    // 1. Pad to square canvas (1080x1080 white)
    const squaredBuffer = await processToSquare(imageBuffer);

    // 2. Convert to optimized WebP (< 100KB)
    const optimizedBuffer = await convertToOptimizedWebP(squaredBuffer);

    // 3. Generate normalized filename
    const filename = `${normalizeName(productName)}.webp`;
    
    if (enableS3) {
      if (!process.env.S3_BUCKET || !process.env.S3_ACCESS_KEY_ID) {
        throw new Error("S3 credentials are not configured but S3 upload is enabled.");
      }

      const key = `images_products_aura/${filename}`;
      const bucket = process.env.S3_BUCKET;

      console.log(`Uploading processed image to S3: ${key} (${Math.round(optimizedBuffer.length / 1024)}KB)`);
      
      await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: optimizedBuffer,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable'
      }));

      const baseUrl = process.env.S3_FILE_URL || `https://${bucket}.s3.${process.env.S3_REGION || 'us-east-2'}.amazonaws.com`;
      return `${baseUrl.replace(/\/$/, '')}/${key}`;
    } else {
      // Local Temporary Storage
      const localPath = path.join(TEMP_DIR, filename);
      fs.writeFileSync(localPath, optimizedBuffer);
      
      console.log(`Saved image locally (S3 OFF): ${localPath} (${Math.round(optimizedBuffer.length / 1024)}KB)`);
      
      // Schedule deletion after 3 minutes
      setTimeout(() => {
        try {
          if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
            console.log(`Temporary image deleted: ${filename}`);
          }
        } catch (err) {
          logger.error({ err }, `Error deleting temporary image ${filename}`);
        }
      }, 3 * 60 * 1000);

      const port = process.env.PORT || '3000';
      return `http://localhost:${port}/temp/${filename}`;
    }

  } catch (error) {
    // Error tragado (se devuelve la URL original): pino en vez de console.error
    // para que viaje con trace context al pipeline OTel → Loki.
    logger.error({ err: error }, "Error processing image");
    return imageUrl;
  }
}

/**
 * Processes image from data-uri or base64 string (from client upload).
 * Validates size and optimizes before returning data-uri.
 */
export async function validateAndOptimizeImageData(
  imageDataUri: string,
  productName: string
): Promise<{
  optimized: boolean;
  dataUri: string;
  originalSizeKB: number;
  optimizedSizeKB: number;
}> {
  try {
    // Parse data-uri
    const matches = imageDataUri.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new Error("Invalid data-uri format");
    }

    const base64Data = matches[2];
    const imageBuffer = Buffer.from(base64Data, "base64");
    const originalSizeKB = Math.round(imageBuffer.length / 1024);

    // Size validation
    if (originalSizeKB > 5000) {
      throw new Error(`Image too large: ${originalSizeKB}KB (max 5MB)`);
    }

    console.log(`Validating image for: ${productName} (${originalSizeKB}KB)`);

    // Process image
    const squaredBuffer = await processToSquare(imageBuffer);
    const optimizedBuffer = await convertToOptimizedWebP(squaredBuffer);
    const optimizedSizeKB = Math.round(optimizedBuffer.length / 1024);

    const optimizedDataUri = `data:image/webp;base64,${optimizedBuffer.toString("base64")}`;
    const wasOptimized = optimizedSizeKB < originalSizeKB;

    console.log(
      `Image processed: ${originalSizeKB}KB → ${optimizedSizeKB}KB${wasOptimized ? " (optimized)" : ""}`
    );

    return {
      optimized: wasOptimized,
      dataUri: optimizedDataUri,
      originalSizeKB,
      optimizedSizeKB,
    };
  } catch (error) {
    logger.error({ err: error }, "Error validating/optimizing image");
    throw error;
  }
}
