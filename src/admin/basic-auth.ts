import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** HTTP basic auth for the staff pages. Compares hashes so neither length nor content leaks through timing. */
export function basicAuth(user: string, password: string, realm = "Receptionist admin"): RequestHandler {
  const expected = digest(`${user}:${password}`);
  return (req, res, next) => {
    const header = req.get("authorization");
    const encoded = header?.startsWith("Basic ") ? header.slice(6) : "";
    const supplied = Buffer.from(encoded, "base64").toString("utf8");
    if (encoded && timingSafeEqual(digest(supplied), expected)) {
      next();
      return;
    }
    res.set("WWW-Authenticate", `Basic realm="${realm}", charset="UTF-8"`).sendStatus(401);
  };
}
