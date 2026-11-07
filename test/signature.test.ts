import { describe, expect, it } from "vitest";
import { isValidSignature, signBody } from "../src/whatsapp/signature.js";

const secret = "app-secret";
const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');

describe("isValidSignature", () => {
  it("accepts the signature Meta would send for these exact bytes", () => {
    expect(isValidSignature(body, signBody(body, secret), secret)).toBe(true);
  });

  it("rejects a body changed after signing, even by whitespace", () => {
    const tampered = Buffer.from(body.toString().replace(":", ": "));
    expect(isValidSignature(tampered, signBody(body, secret), secret)).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    expect(isValidSignature(body, signBody(body, "other"), secret)).toBe(false);
  });

  it.each([undefined, "", "sha1=abc", "sha256=", "sha256=zz", `sha256=${"a".repeat(63)}`])("rejects header %j", (header) => {
    expect(isValidSignature(body, header, secret)).toBe(false);
  });
});
