import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

/**
 * Meta signs every webhook POST with HMAC-SHA256 of the raw request body using the App Secret,
 * sent as `X-Hub-Signature-256: sha256=<hex>`. The check must run on the exact bytes received,
 * before any JSON parsing.
 */
export function isValidSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith(PREFIX)) return false;
  const received = Buffer.from(header.slice(PREFIX.length), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function signBody(rawBody: Buffer | string, appSecret: string): string {
  return PREFIX + createHmac("sha256", appSecret).update(rawBody).digest("hex");
}
