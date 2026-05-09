import { FastifyRequest, FastifyReply } from "fastify";

const VALID_TOKENS = new Map<string, { name: string; createdAt: number }>();

export function generateToken(): string {
  return `scraper_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

export function registerToken(token: string, name: string): void {
  VALID_TOKENS.set(token, {
    name,
    createdAt: Date.now(),
  });
}

export function isValidToken(token: string | undefined): boolean {
  if (!token) return false;

  // Master static token check
  if (process.env.SCRAPER_API_TOKEN && token === process.env.SCRAPER_API_TOKEN) {
    return true;
  }

  const entry = VALID_TOKENS.get(token);
  if (!entry) return false;

  // Dynamic tokens expire after 24 hours
  const isExpired = Date.now() - entry.createdAt > 24 * 60 * 60 * 1000;
  if (isExpired) {
    VALID_TOKENS.delete(token);
    return false;
  }

  return true;
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  const token = authHeader?.replace("Bearer ", "");

  if (!isValidToken(token)) {
    reply.status(401).send({
      error: "Unauthorized",
      message: "Missing or invalid API token",
    });
  }
}

export function getTokenFromRequest(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  const token = authHeader?.replace("Bearer ", "");
  return token || null;
}
