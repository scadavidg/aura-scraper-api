import { Perfume } from "./schema";

interface ScrapeSession {
  id: string;
  scrapedData: Perfume;
  confirmedData?: Perfume;
  createdAt: number;
  expiresAt: number;
}

const SESSIONS = new Map<string, ScrapeSession>();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

export function generateSessionId(): string {
  return `scrape_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export function createSession(scrapedData: Perfume): string {
  const sessionId = generateSessionId();
  const now = Date.now();

  SESSIONS.set(sessionId, {
    id: sessionId,
    scrapedData,
    createdAt: now,
    expiresAt: now + SESSION_TTL,
  });

  return sessionId;
}

export function getSession(sessionId: string): ScrapeSession | null {
  const session = SESSIONS.get(sessionId);
  if (!session) return null;

  // Check expiration
  if (Date.now() > session.expiresAt) {
    SESSIONS.delete(sessionId);
    return null;
  }

  return session;
}

export function updateSessionConfirmation(
  sessionId: string,
  confirmedData: Perfume
): boolean {
  const session = getSession(sessionId);
  if (!session) return false;

  session.confirmedData = confirmedData;
  SESSIONS.set(sessionId, session);
  return true;
}

export function deleteSession(sessionId: string): void {
  SESSIONS.delete(sessionId);
}

// Cleanup expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of SESSIONS.entries()) {
    if (now > session.expiresAt) {
      SESSIONS.delete(id);
    }
  }
}, 5 * 60 * 1000);
