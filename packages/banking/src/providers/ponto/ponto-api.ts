import { Buffer } from "node:buffer";
import https from "node:https";
import { env } from "../../env";
import { ProviderError } from "../../utils/error";
import { logger } from "../../utils/logger";
import type {
  PontoAccount,
  PontoCollection,
  PontoFinancialInstitution,
  PontoSingle,
  PontoTokenResponse,
  PontoTransaction,
} from "./types";

const BASE_URL = "https://api.ibanity.com/ponto-connect";

/**
 * Ponto Connect (Ibanity) API client. Spark-owned bank pipe: every call rides
 * mTLS (client certificate from env), and account-scoped calls authenticate
 * with a user access token minted from the per-connection refresh token
 * (stored in bank_connections.access_token, passed in as `accessToken`).
 *
 * Ibanity's OAuth server (Ory) ROTATES refresh tokens on use, so after every
 * refresh we persist the replacement back to bank_connections via PostgREST.
 * ponytail: single-tenant write-back by previous token value; move to a proper
 * token store if this fork ever serves multiple teams.
 */
export class PontoApi {
  #mtlsCert: string;
  #mtlsKey: string;
  #clientId: string;
  #clientSecret: string;

  // In-memory access-token cache per refresh token (worker syncs both accounts
  // in one process; no need to refresh twice within a run).
  static #tokenCache = new Map<string, { accessToken: string; expiresAt: number; rotatedTo?: string }>();

  constructor() {
    this.#mtlsCert = env.PONTO_MTLS_CERT.replace(/\\n/g, "\n");
    this.#mtlsKey = env.PONTO_MTLS_KEY.replace(/\\n/g, "\n");
    this.#clientId = env.PONTO_CLIENT_ID;
    this.#clientSecret = env.PONTO_CLIENT_SECRET;
  }

  async #request<T>(
    url: string,
    opts: { method?: string; token?: string; body?: string; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const u = new URL(url);
    return new Promise<T>((resolve, reject) => {
      const req = https.request(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          method: opts.method ?? "GET",
          cert: this.#mtlsCert,
          key: this.#mtlsKey,
          headers: {
            Accept: "application/json",
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
            ...(opts.headers ?? {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              resolve(text ? (JSON.parse(text) as T) : ({} as T));
            } else {
              reject(
                new ProviderError({
                  message: `Ponto ${status}: ${text.slice(0, 300)}`,
                  code: status === 401 ? "disconnected" : "unknown",
                }),
              );
            }
          });
        },
      );
      req.on("error", (err) => reject(new ProviderError({ message: String(err), code: "unknown" })));
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  /** Mint a user access token from the connection's refresh token (cached). */
  async #userToken(refreshToken: string): Promise<string> {
    const cached = PontoApi.#tokenCache.get(refreshToken);
    if (cached && cached.expiresAt > Date.now() + 30_000) {
      return cached.accessToken;
    }
    // If this refresh token was already rotated in-process, follow the chain.
    if (cached?.rotatedTo) {
      return this.#userToken(cached.rotatedTo);
    }

    const basic = Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString();

    const tok = await this.#request<PontoTokenResponse>(`${BASE_URL}/oauth2/token`, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
    });

    PontoApi.#tokenCache.set(refreshToken, {
      accessToken: tok.access_token,
      expiresAt: Date.now() + (tok.expires_in - 60) * 1000,
      rotatedTo: tok.refresh_token && tok.refresh_token !== refreshToken ? tok.refresh_token : undefined,
    });

    if (tok.refresh_token && tok.refresh_token !== refreshToken) {
      await this.#persistRotatedToken(refreshToken, tok.refresh_token);
    }

    return tok.access_token;
  }

  /** Write the rotated refresh token back to bank_connections (PostgREST). */
  async #persistRotatedToken(oldToken: string, newToken: string): Promise<void> {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
      logger.error("ponto: cannot persist rotated refresh token (missing Supabase env)");
      return;
    }
    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/bank_connections?provider=eq.ponto&access_token=eq.${encodeURIComponent(oldToken)}`,
        {
          method: "PATCH",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ access_token: newToken }),
        },
      );
      if (!res.ok) {
        logger.error(`ponto: rotated-token persist failed (${res.status})`);
      }
    } catch (err) {
      logger.error(`ponto: rotated-token persist error: ${String(err)}`);
    }
  }

  async getHealthCheck(): Promise<boolean> {
    try {
      // Client-credentials token doubles as a liveness probe (mTLS + OAuth).
      const basic = Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString("base64");
      await this.#request<PontoTokenResponse>(`${BASE_URL}/oauth2/token`, {
        method: "POST",
        body: "grant_type=client_credentials",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  async getAccounts(refreshToken: string): Promise<PontoAccount[]> {
    const token = await this.#userToken(refreshToken);
    const res = await this.#request<PontoCollection<PontoAccount>>(`${BASE_URL}/accounts?limit=100`, { token });
    return res.data;
  }

  async getAccount(refreshToken: string, accountId: string): Promise<PontoAccount> {
    const token = await this.#userToken(refreshToken);
    const res = await this.#request<PontoSingle<PontoAccount>>(`${BASE_URL}/accounts/${accountId}`, { token });
    return res.data;
  }

  /**
   * List transactions. `latest` fetches one page (newest first); a full sync
   * follows pagination up to `maxPages`.
   */
  async getTransactions(
    refreshToken: string,
    accountId: string,
    opts: { latest?: boolean; maxPages?: number } = {},
  ): Promise<PontoTransaction[]> {
    const token = await this.#userToken(refreshToken);
    const maxPages = opts.latest ? 1 : (opts.maxPages ?? 20);
    const all: PontoTransaction[] = [];
    let url: string | undefined = `${BASE_URL}/accounts/${accountId}/transactions?limit=100`;

    for (let page = 0; page < maxPages && url; page++) {
      const res: PontoCollection<PontoTransaction> = await this.#request<PontoCollection<PontoTransaction>>(url, {
        token,
      });
      all.push(...res.data);
      url = res.links?.next;
    }
    return all;
  }

  async getFinancialInstitution(refreshToken: string, id: string): Promise<PontoFinancialInstitution | null> {
    try {
      const token = await this.#userToken(refreshToken);
      const res = await this.#request<PontoSingle<PontoFinancialInstitution>>(
        `${BASE_URL}/financial-institutions/${id}`,
        { token },
      );
      return res.data;
    } catch {
      return null;
    }
  }
}
