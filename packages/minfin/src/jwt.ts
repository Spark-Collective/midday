/**
 * Client-authentication JWT (private_key_jwt, RFC 7523) for the token endpoint.
 *
 * Header: alg RS256, typ JWT, kid (must match a key in our published JWKS, use=sig).
 * Body:   iss=sub=clientID, aud=token endpoint URL, exp (< 30 min out), jti (random).
 * Signed with our RS256 private key.
 */
import { createSign, randomUUID } from "node:crypto";

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface AssertionOpts {
  clientId: string;
  /** Exact token endpoint URL, becomes the `aud`. */
  tokenUrl: string;
  privateKeyPem: string;
  kid: string;
  /** Lifetime in seconds; FPSFin rejects > 30 min. Default 5 min. */
  ttlSeconds?: number;
  /** Injectable clock for tests (unix seconds). */
  now?: () => number;
}

/** Build and sign the client_assertion JWT. */
export function buildClientAssertion(o: AssertionOpts): string {
  const now = (o.now ?? (() => Math.floor(Date.now() / 1000)))();
  const ttl = Math.min(o.ttlSeconds ?? 300, 1799); // stay safely under 30 min
  const header = { alg: "RS256", typ: "JWT", kid: o.kid };
  const body = {
    iss: o.clientId,
    sub: o.clientId,
    aud: o.tokenUrl,
    exp: now + ttl,
    jti: randomUUID(),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(o.privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

/** Decode a JWT body without verifying (for reading id_token claims we already trust from TLS). */
export function decodeJwtBody(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("malformed JWT");
  const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json);
}
