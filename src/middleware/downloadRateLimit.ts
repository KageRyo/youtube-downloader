import { RequestHandler } from "express";
import { env } from "../config/env";

// Per-process limiter with a bounded client table. Forwarded IP headers are not trusted.
export function createDownloadRateLimit(): RequestHandler {
  const clients = new Map<string, { count: number; expiresAt: number }>();
  const windowMs = 60_000;
  const maxClients = 1024;
  return (req, res, next) => {
    const now = Date.now();
    for (const [key, entry] of clients) {
      if (entry.expiresAt <= now) clients.delete(key);
    }
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    let entry = clients.get(key);
    if (!entry && clients.size < maxClients) {
      entry = { count: 0, expiresAt: now + windowMs };
      clients.set(key, entry);
    }
    if (!entry || entry.count >= env.creationRateLimit) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil(((entry?.expiresAt ?? now + windowMs) - now) / 1000)));
      res.status(429).json({ message: "Too many download submissions. Retry after the indicated delay." });
      return;
    }
    entry.count += 1;
    next();
  };
}
