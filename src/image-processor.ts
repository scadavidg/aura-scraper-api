import sharp from 'sharp';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';

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
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
const TARGET_MAX_BYTES = 100 * 1024; // 100KB
const TEMP_DIR = path.join(process.cwd(), 'temp_images');

// Asegurar que el directorio temporal existe
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Normalizes a string by converting to lowercase, removing spaces, 
 * and removing accents (diacritics).
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove accents
    .replace(/\s+/g, ""); // Remove spaces
}

/**
 * Pads an image to a square canvas of OUTPUT_SIZE x OUTPUT_SIZE with white background.
 */
async function processToSquare(imageBuffer: Buffer): Promise<Buffer> {
  // 1. Trim whitespace and resize to fit inside the target size
  const resized = await sharp(imageBuffer)
    .trim()
    .resize(OUTPUT_SIZE, OUTPUT_SIZE, { 
      fit: 'inside', 
      withoutEnlargement: false 
    })
    .toBuffer();

  const { width = OUTPUT_SIZE, height = OUTPUT_SIZE } = await sharp(resized).metadata();

  // 2. Symmetric padding
  const padTop = Math.floor((OUTPUT_SIZE - height) / 2);
  const padLeft = Math.floor((OUTPUT_SIZE - width) / 2);

  return sharp(resized)
    .extend({
      top: padTop,
      bottom: OUTPUT_SIZE - height - padTop,
      left: padLeft,
      right: OUTPUT_SIZE - width - padLeft,
      background: WHITE,
    })
    .toBuffer();
}

/**
 * Iteratively tries to convert the image to WebP under the target size.
 */
async function convertToOptimizedWebP(imageBuffer: Buffer): Promise<Buffer> {
  let quality = 80;
  let resultBuffer = await sharp(imageBuffer)
    .webp({ quality, effort: 6 })
    .toBuffer();

  // If already under target, return
  if (resultBuffer.length <= TARGET_MAX_BYTES) return resultBuffer;

  // Otherwise, reduce quality until it fits or reaches a minimum
  while (resultBuffer.length > TARGET_MAX_BYTES && quality > 30) {
    quality -= 10;
    resultBuffer = await sharp(imageBuffer)
      .webp({ quality, effort: 6 })
      .toBuffer();
  }

  return resultBuffer;
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
          console.error(`Error deleting temporary image ${filename}:`, err);
        }
      }, 3 * 60 * 1000);

      const port = process.env.PORT || '3000';
      return `http://localhost:${port}/temp/${filename}`;
    }

  } catch (error) {
    console.error("Error processing image:", error);
    return imageUrl; 
  }
}
