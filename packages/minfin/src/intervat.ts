/**
 * Intervat API client: submit VAT periodic declarations.
 *
 * Base: {apiBase}/Intervat/api/OAU/v1
 *   POST /declaration/vat/{vatNumber}?lang=  (body: the declaration file)
 *        -> 200 { pdfReference, xmlReference }   (submission proof, fetch next-day via MMF API)
 *        -> 400 { businessrules: [...] }          (validation errors)
 *   GET  /health
 *
 * Auth: Bearer token with scope `vat-manage-api`. Every call also carries the
 * gateway-required Minfin-Ws-Correlation UUID header (same as FineAPI).
 *
 * The OpenAPI declares the body as application/zip; the doc also allows a raw XML
 * file (with annexes only inside a zip). We send the Content-Type by file extension
 * (.zip -> application/zip, .xml -> application/xml) and let the API decide.
 */
import { randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";

const intervatBase = (apiBase: string): string =>
  `${apiBase}/Intervat/api/OAU/v1`;

/**
 * Build a minimal single-entry ZIP (STORE, no compression). The Intervat API only
 * accepts application/zip (415 on raw XML), so an .xml is wrapped in a zip here.
 * Pure Node: manual zip records + zlib.crc32, no dependency.
 */
export function zipSingleFile(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data) >>> 0;
  const n = data.length;
  const dosTime = 0, dosDate = 0x21; // 1980-01-01, deterministic
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(0, 6);
  lfh.writeUInt16LE(0, 8); lfh.writeUInt16LE(dosTime, 10); lfh.writeUInt16LE(dosDate, 12);
  lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(n, 18); lfh.writeUInt32LE(n, 22);
  lfh.writeUInt16LE(nameBuf.length, 26); lfh.writeUInt16LE(0, 28);
  const local = Buffer.concat([lfh, nameBuf, data]);
  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(0, 8); cdh.writeUInt16LE(0, 10); cdh.writeUInt16LE(dosTime, 12);
  cdh.writeUInt16LE(dosDate, 14); cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(n, 20);
  cdh.writeUInt32LE(n, 24); cdh.writeUInt16LE(nameBuf.length, 28); cdh.writeUInt32LE(0, 42);
  const central = Buffer.concat([cdh, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

export interface DocumentReference {
  pdfReference: string;
  xmlReference: string;
}

/** Format a business-validation problem into a readable multi-line string. */
function formatProblem(raw: string): string {
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p.businessrules) && p.businessrules.length) {
      const lines = p.businessrules.map((r: { vatNumber?: string; errorIdentifier?: string; type?: string; descriptions?: Record<string, string> }) => {
        const d = r.descriptions?.en || r.descriptions?.nl || r.descriptions?.fr || "";
        return `  [${r.type ?? ""}] ${r.errorIdentifier ?? ""} (vat ${r.vatNumber ?? "?"}): ${d}`;
      });
      return `${p.title ?? "Business validation error"} (${p.instance ?? ""}):\n${lines.join("\n")}`;
    }
    return `${p.title ?? ""} ${p.detail ?? ""} ${p.instance ? `[${p.instance}]` : ""}`.trim() || raw.slice(0, 400);
  } catch {
    return raw.slice(0, 400);
  }
}

export class IntervatError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** v2026 declarationType codes (case sensitive). `vat` = the legacy periodic-return path. */
export const DECLARATION_TYPES = [
  "vat", // legacy URL, supported until 31.12.2027
  "tva", "lc", "ico", "vr", "prorata", "mtn", "special_629", "curator", "cds",
] as const;
export type DeclarationType = (typeof DECLARATION_TYPES)[number];

/** Submit a VAT document. Default type `vat` = the legacy periodic-return URL;
 *  any v2026 code (tva, lc, ico, ...) uses the new generic endpoint. */
export async function submitVat(input: {
  apiBase: string;
  accessToken: string;
  vatNumber: string;
  /** The XML (or a ready zip) as bytes; no filesystem in the server path. */
  content: Buffer;
  filename: string;
  lang?: string;
  declarationType?: DeclarationType;
}): Promise<DocumentReference> {
  const {
    apiBase,
    accessToken,
    vatNumber,
    content,
    filename,
    lang,
    declarationType = "vat",
  } = input;
  const vat = vatNumber.replace(/\D/g, "");
  if (!/^[0-1][0-9]{9}$/.test(vat)) throw new IntervatError(`vatNumber must be 10 digits (got '${vatNumber}')`, 0);
  if (!DECLARATION_TYPES.includes(declarationType)) {
    throw new IntervatError(`unknown declaration type '${declarationType}' (know: ${DECLARATION_TYPES.join(", ")})`, 0);
  }
  // The API only accepts application/zip. A .zip is sent as-is; anything else
  // (typically the .xml declaration) is wrapped in a single-entry zip.
  const body = /\.zip$/i.test(filename)
    ? content
    : zipSingleFile(filename, content);
  const qs = lang ? `?lang=${encodeURIComponent(lang)}` : "";
  const res = await fetch(`${intervatBase(apiBase)}/declaration/${declarationType}/${vat}${qs}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/zip",
      Accept: "application/json",
      "Minfin-Ws-Correlation": randomUUID(),
    },
    body: new Blob([new Uint8Array(body)]),
  });
  const raw = await res.text();
  if (!res.ok) throw new IntervatError(`Intervat ${res.status}:\n${formatProblem(raw)}`, res.status);
  return JSON.parse(raw) as DocumentReference;
}

/** Health check (may be restricted to supervision users). */
export async function intervatHealth(
  apiBase: string,
  accessToken: string,
): Promise<string> {
  const res = await fetch(`${intervatBase(apiBase)}/health`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Minfin-Ws-Correlation": randomUUID() },
  });
  return `${res.status} ${await res.text()}`.slice(0, 300);
}
