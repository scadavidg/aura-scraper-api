import fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "path";
import dotenv from "dotenv";
import { scrapePerfumePage } from "./scraper";

dotenv.config();

const server = fastify({ logger: true });

// Register static files to serve temporary images
server.register(fastifyStatic, {
  root: path.join(process.cwd(), "temp_images"),
  prefix: "/temp/",
});

server.post("/scrape", async (request, reply) => {
  try {
    const { url, imageUrl } = request.body as { url: string; imageUrl?: string };
    
    if (!url) {
      return reply.status(400).send({ error: "URL is required" });
    }
    
    server.log.info(`Scraping started for: ${url}${imageUrl ? ` with direct image: ${imageUrl}` : ''}`);
    const data = await scrapePerfumePage(url, imageUrl);
    
    return reply.status(200).send(data);
  } catch (error) {
    server.log.error(error);
    return reply.status(500).send({ error: "Failed to scrape the page" });
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