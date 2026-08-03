/**
 * Server-side MinFin token handling.
 *
 * The server never runs the browser consent — that is a human act with an eID.
 * It only REFRESHES an existing token, which is all a headless submitter needs.
 *
 * Ownership matters: FPS refresh tokens are single-use and rotate on every
 * refresh, so exactly one holder can refresh a given token. When the server
 * takes over, the operator's local CLI must stop refreshing that environment or
 * the two will invalidate each other. See docs/integrations/minfin-apis.md.
 */
import { buildClientAssertion } from "./jwt.js";

const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

export type MinfinEnv = "test" | "prod";

export const TOKEN_URL: Record<MinfinEnv, string> = {
  test: "https://fediamapi-a.minfin.be/sso/oauth2/access_token",
  prod: "https://fediamapi.minfin.fgov.be/sso/oauth2/access_token",
};

export const API_BASE: Record<MinfinEnv, string> = {
  test: "https://wsapi-a.minfin.be",
  prod: "https://wsapi.minfin.fgov.be",
};

export type ClientCreds = {
  clientId: string;
  privateKeyPem: string;
  kid: string;
};

export type TokenSet = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  /** Unix seconds when this set was obtained. */
  obtained_at: number;
};

export class MinfinError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

/**
 * Exchange a refresh token for a fresh set. Returns the NEW refresh token, which
 * the caller must persist: the old one is dead the moment this succeeds.
 */
export async function refreshToken(input: {
  env: MinfinEnv;
  creds: ClientCreds;
  refreshToken: string;
}): Promise<TokenSet> {
  const tokenUrl = TOKEN_URL[input.env];
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.creds.clientId,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: buildClientAssertion({
      clientId: input.creds.clientId,
      tokenUrl,
      privateKeyPem: input.creds.privateKeyPem,
      kid: input.creds.kid,
    }),
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new MinfinError(
      `token endpoint ${res.status}: ${raw.slice(0, 300)}`,
      res.status,
    );
  }
  const t = JSON.parse(raw) as Omit<TokenSet, "obtained_at">;
  if (!t.refresh_token) {
    throw new MinfinError(
      "token response carried no refresh_token; refusing to drop the only credential we have",
    );
  }
  return { ...t, obtained_at: Math.floor(Date.now() / 1000) };
}

/** True when a stored set is still usable (30s skew, matching the CLI). */
export function isFresh(t: {
  obtained_at: number;
  expires_in: number;
}): boolean {
  return t.obtained_at + t.expires_in - 30 > Math.floor(Date.now() / 1000);
}

/** Read client credentials from the environment; throws with a clear message. */
export function credsFromEnv(): ClientCreds {
  const clientId = process.env.MINFIN_CLIENT_ID;
  const privateKeyPem = process.env.MINFIN_PRIVATE_KEY;
  const kid = process.env.MINFIN_KID;
  const missing = [
    !clientId && "MINFIN_CLIENT_ID",
    !privateKeyPem && "MINFIN_PRIVATE_KEY",
    !kid && "MINFIN_KID",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new MinfinError(
      `MinFin submission is not configured on this deployment (missing ${missing.join(", ")}).`,
    );
  }
  return {
    clientId: clientId!,
    // Env vars cannot hold real newlines; accept the \n-escaped form.
    privateKeyPem: privateKeyPem!.replace(/\\n/g, "\n"),
    kid: kid!,
  };
}
