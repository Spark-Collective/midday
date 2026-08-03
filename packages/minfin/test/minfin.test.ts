/**
 * The parts that can be tested without touching FPS: the zip encoder (their API
 * rejects anything that is not a valid archive) and the client assertion.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { zipSingleFile } from "../src/intervat.js";
import { buildClientAssertion, decodeJwtBody } from "../src/jwt.js";
import { credsFromEnv, isFresh, MinfinError } from "../src/token.js";

describe("zip encoder", () => {
  test("produces a real single-entry archive", () => {
    const payload = Buffer.from("<?xml version='1.0'?><x/>", "utf8");
    const zip = zipSingleFile("return.xml", payload);
    // Local file header, central directory, end-of-central-directory.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.includes(Buffer.from("PK\x01\x02", "binary"))).toBe(true);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    // The payload is stored, so it appears verbatim.
    expect(zip.includes(payload)).toBe(true);
    expect(zip.includes(Buffer.from("return.xml"))).toBe(true);
  });

  test("is deterministic (same input, same bytes)", () => {
    const a = zipSingleFile("a.xml", Buffer.from("hello"));
    const b = zipSingleFile("a.xml", Buffer.from("hello"));
    expect(a.equals(b)).toBe(true);
  });
});

describe("client assertion", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

  test("carries the claims FPS validates", () => {
    const jwt = buildClientAssertion({
      clientId: "sparkcollective",
      tokenUrl: "https://example.test/token",
      privateKeyPem: pem,
      kid: "kid-1",
      now: () => 1_000_000,
    });
    const [h, b] = jwt.split(".");
    const header = JSON.parse(
      Buffer.from(h!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
    );
    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-1" });
    const body = decodeJwtBody(jwt);
    expect(body.iss).toBe("sparkcollective");
    expect(body.sub).toBe("sparkcollective");
    expect(body.aud).toBe("https://example.test/token");
    // FPS rejects an assertion valid longer than 30 minutes.
    expect((body.exp as number) - 1_000_000).toBeLessThanOrEqual(1799);
    expect(body.jti).toBeTruthy();
  });
});

describe("token freshness + config", () => {
  test("isFresh respects the 30s skew", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isFresh({ obtained_at: now, expires_in: 3600 })).toBe(true);
    expect(isFresh({ obtained_at: now - 3600, expires_in: 3600 })).toBe(false);
    // Inside the skew window counts as stale.
    expect(isFresh({ obtained_at: now - 3580, expires_in: 3600 })).toBe(false);
  });

  test("missing configuration fails with a message that names what is missing", () => {
    const saved = { ...process.env };
    process.env.MINFIN_CLIENT_ID = undefined as unknown as string;
    delete process.env.MINFIN_CLIENT_ID;
    delete process.env.MINFIN_PRIVATE_KEY;
    delete process.env.MINFIN_KID;
    try {
      expect(() => credsFromEnv()).toThrow(MinfinError);
      expect(() => credsFromEnv()).toThrow(/MINFIN_CLIENT_ID/);
    } finally {
      Object.assign(process.env, saved);
    }
  });

  test("escaped newlines in the env private key are restored", () => {
    const saved = { ...process.env };
    process.env.MINFIN_CLIENT_ID = "c";
    process.env.MINFIN_KID = "k";
    process.env.MINFIN_PRIVATE_KEY = "-----BEGIN----\\nline\\n-----END----";
    try {
      expect(credsFromEnv().privateKeyPem).toBe(
        "-----BEGIN----\nline\n-----END----",
      );
    } finally {
      Object.assign(process.env, saved);
    }
  });
});
