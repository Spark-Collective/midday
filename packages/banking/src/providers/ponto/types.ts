// Ponto Connect (Ibanity) JSON:API shapes — only the fields we consume.
// API reference: https://documentation.ibanity.com/ponto-connect/2/api

export type PontoTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
};

export type PontoAccountAttributes = {
  description: string | null;
  reference: string; // IBAN
  referenceType: string; // "IBAN"
  currency: string;
  subtype: string | null; // "checking"
  currentBalance: number;
  availableBalance: number;
  holderName: string | null;
  authorizationExpirationExpectedAt: string | null;
  deprecated: boolean;
};

export type PontoAccount = {
  id: string;
  type: "account";
  attributes: PontoAccountAttributes;
  relationships?: {
    financialInstitution?: { data?: { id: string } };
  };
};

export type PontoTransactionAttributes = {
  amount: number; // negative = debit
  currency: string;
  executionDate: string;
  valueDate: string;
  counterpartName: string | null;
  counterpartReference: string | null; // IBAN of counterpart
  description: string | null;
  remittanceInformation: string | null;
  remittanceInformationType: string | null;
  proprietaryBankTransactionCode: string | null;
  additionalInformation: string | null;
};

export type PontoTransaction = {
  id: string;
  type: "transaction";
  attributes: PontoTransactionAttributes;
};

export type PontoFinancialInstitution = {
  id: string;
  type: "financialInstitution";
  attributes: {
    name: string;
    logoUrl?: string | null;
  };
};

export type PontoCollection<T> = {
  data: T[];
  links?: { next?: string; prev?: string; first?: string };
  meta?: { paging?: { limit: number; before?: string; after?: string } };
};

export type PontoSingle<T> = {
  data: T;
};
