import type { Provider } from "../../interface";
import type {
  DeleteAccountsRequest,
  DeleteConnectionRequest,
  GetAccountBalanceRequest,
  GetAccountBalanceResponse,
  GetAccountsRequest,
  GetAccountsResponse,
  GetConnectionStatusRequest,
  GetInstitutionsRequest,
  GetTransactionsRequest,
  GetTransactionsResponse,
  Institution,
} from "../../types";
import { PontoApi } from "./ponto-api";
import {
  transformAccount,
  transformBalance,
  transformConnectionStatus,
  transformInstitution,
  transformTransaction,
} from "./transform";

/**
 * Spark-owned Ponto Connect (Ibanity) provider. The per-connection credential
 * (bank_connections.access_token, arriving here as `accessToken`) is the OAuth
 * REFRESH token; the api client mints short-lived access tokens from it and
 * persists rotations. Single Ponto integration covers all connected banks
 * (currently KBC + Revolut Business).
 */
export class PontoProvider implements Provider {
  #api: PontoApi;

  constructor() {
    this.#api = new PontoApi();
  }

  async getHealthCheck() {
    return this.#api.getHealthCheck();
  }

  async getInstitutions(_params: GetInstitutionsRequest) {
    // Single-tenant: institutions come from the already-connected accounts.
    return [
      { id: "ponto", name: "Ponto (Isabel Group)", logo: null, provider: "ponto" as const },
    ];
  }

  async #institutionFor(accessToken: string, account: { relationships?: { financialInstitution?: { data?: { id: string } } } }): Promise<Institution | null> {
    const fiId = account.relationships?.financialInstitution?.data?.id;
    if (!fiId) return null;
    const fi = await this.#api.getFinancialInstitution(accessToken, fiId);
    return transformInstitution(fi);
  }

  async getAccounts({ accessToken }: GetAccountsRequest): Promise<GetAccountsResponse> {
    if (!accessToken) {
      throw Error("Missing params: accessToken (Ponto refresh token)");
    }
    const accounts = await this.#api.getAccounts(accessToken);
    const out = [];
    for (const account of accounts) {
      const institution = await this.#institutionFor(accessToken, account);
      out.push(transformAccount(account, institution));
    }
    return out;
  }

  async getAccountBalance(
    params: GetAccountBalanceRequest,
  ): Promise<GetAccountBalanceResponse> {
    if (!params.accessToken) {
      throw Error("Missing params: accessToken (Ponto refresh token)");
    }
    const account = await this.#api.getAccount(params.accessToken, params.accountId);
    return transformBalance(account);
  }

  async getTransactions(
    params: GetTransactionsRequest,
  ): Promise<GetTransactionsResponse> {
    if (!params.accessToken) {
      throw Error("Missing params: accessToken (Ponto refresh token)");
    }
    const transactions = await this.#api.getTransactions(params.accessToken, params.accountId, {
      latest: params.latest,
    });
    return transactions.map(transformTransaction);
  }

  async getConnectionStatus({ accessToken }: GetConnectionStatusRequest) {
    if (!accessToken) {
      return { status: "disconnected" as const };
    }
    try {
      const accounts = await this.#api.getAccounts(accessToken);
      return transformConnectionStatus(accounts);
    } catch {
      return { status: "disconnected" as const };
    }
  }

  async deleteAccounts(_params: DeleteAccountsRequest) {
    // Revoking the Ponto integration is done from the Ponto dashboard;
    // deleting rows in Midday should not sever the bank authorization.
  }

  async deleteConnection(_params: DeleteConnectionRequest) {
    // Same as deleteAccounts: intentionally a no-op on the Ponto side.
  }
}
