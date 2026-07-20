import { formatISO } from "date-fns";
import type { Account, Balance, Institution, Transaction } from "../../types";
import type { AccountType } from "../../utils/account";
import type { PontoAccount, PontoFinancialInstitution, PontoTransaction } from "./types";

export function transformInstitution(fi: PontoFinancialInstitution | null): Institution {
  return {
    id: fi?.id ?? "ponto",
    name: fi?.attributes.name ?? "Bank (Ponto)",
    logo: fi?.attributes.logoUrl ?? null,
    provider: "ponto",
  };
}

// All connected Ponto accounts are business checking accounts.
const ACCOUNT_TYPE: AccountType = "depository";

export function transformAccount(
  account: PontoAccount,
  institution: Institution | null,
): Account {
  const at = account.attributes;
  return {
    id: account.id,
    name: at.description || at.holderName || at.reference,
    currency: at.currency,
    type: ACCOUNT_TYPE,
    institution: institution ?? transformInstitution(null),
    balance: {
      amount: at.currentBalance,
      currency: at.currency,
    },
    enrollment_id: null,
    resource_id: account.id,
    expires_at: at.authorizationExpirationExpectedAt,
    iban: at.referenceType === "IBAN" ? at.reference : null,
    subtype: at.subtype,
    bic: null,
    routing_number: null,
    wire_routing_number: null,
    account_number: null,
    sort_code: null,
    available_balance: at.availableBalance ?? null,
    credit_limit: null,
  };
}

export function transformBalance(account: PontoAccount): {
  currency: string;
  amount: number;
  available_balance: number | null;
  credit_limit: number | null;
} {
  const at = account.attributes;
  return {
    currency: at.currency,
    amount: at.currentBalance,
    available_balance: at.availableBalance ?? null,
    credit_limit: null,
  };
}

function transactionName(t: PontoTransaction): string {
  const at = t.attributes;
  return (
    at.counterpartName ||
    at.remittanceInformation ||
    at.description ||
    at.additionalInformation ||
    "Unknown"
  );
}

function transactionMethod(t: PontoTransaction): string {
  const code = (t.attributes.proprietaryBankTransactionCode || "").toLowerCase();
  if (code.includes("card")) return "card_purchase";
  if (code.includes("transfer") || code.includes("payment")) return "payment";
  return "other";
}

export function transformTransaction(t: PontoTransaction): Transaction {
  const at = t.attributes;
  const date = at.executionDate || at.valueDate;
  return {
    id: t.id,
    amount: at.amount,
    currency: at.currency,
    date: formatISO(new Date(date), { representation: "date" }),
    status: "posted", // Ponto only returns booked transactions
    balance: null,
    category: at.amount > 0 ? "income" : null,
    counterparty_name: at.counterpartName,
    merchant_name: at.counterpartName,
    method: transactionMethod(t),
    name: transactionName(t),
    description: at.remittanceInformation || at.description,
    currency_rate: null,
    currency_source: null,
  };
}

export function transformConnectionStatus(accounts: PontoAccount[]): {
  status: "connected" | "disconnected";
} {
  // Connected while at least one non-deprecated account with unexpired
  // authorization remains.
  const alive = accounts.some(
    (a) =>
      !a.attributes.deprecated &&
      (!a.attributes.authorizationExpirationExpectedAt ||
        new Date(a.attributes.authorizationExpirationExpectedAt) > new Date()),
  );
  return { status: alive ? "connected" : "disconnected" };
}

export type { Balance };
