/**
 * Minimal Recommand (Peppol access point) client for the spark fork.
 * HTTP Basic auth from env; the same API the spark-peppol CLI and
 * spark-docs peppol-sync use. Recommand builds UBL from structured JSON
 * on /send, so no UBL generation lives here.
 */

const BASE = process.env.RECOMMAND_URL || "https://app.recommand.eu";

function auth(): string {
  const key = process.env.RECOMMAND_API_KEY;
  const secret = process.env.RECOMMAND_API_SECRET;
  if (!key || !secret) {
    throw new Error("RECOMMAND_API_KEY / RECOMMAND_API_SECRET not set");
  }
  return `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`;
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: auth(),
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Recommand ${res.status} on ${path}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

export interface PeppolParsed {
  invoiceNumber?: string;
  issueDate?: string;
  dueDate?: string;
  currency?: string;
  seller?: { name?: string; vatNumber?: string; country?: string };
  buyer?: { name?: string; vatNumber?: string; country?: string };
  totals?: { payableAmount?: string; taxInclusiveAmount?: string };
  attachments?: Array<{
    filename?: string;
    mimeCode?: string;
    content?: string;
    embeddedDocument?: string;
  }>;
}

export interface PeppolDocument {
  id: string;
  direction: "incoming" | "outgoing";
  type: string;
  senderId?: string;
  createdAt?: string;
  parsed?: PeppolParsed;
  xml?: string;
}

export async function listDocuments(limit = 100): Promise<PeppolDocument[]> {
  const d = await call<{ documents?: PeppolDocument[] }>(`/api/v1/documents?limit=${limit}`);
  return d.documents ?? [];
}

export async function getDocument(id: string): Promise<PeppolDocument> {
  const d = await call<{ document?: PeppolDocument }>(`/api/v1/documents/${id}`);
  return d.document ?? (d as unknown as PeppolDocument);
}

/** Send a document. body: { recipient, documentType, document } */
export async function sendDocument(body: {
  recipient?: string;
  documentType: string;
  document: unknown;
}): Promise<Record<string, unknown>> {
  const companyId = process.env.PEPPOL_COMPANY_ID;
  if (!companyId) throw new Error("PEPPOL_COMPANY_ID not set");
  return call(`/api/v1/${companyId}/send`, { method: "POST", body });
}
