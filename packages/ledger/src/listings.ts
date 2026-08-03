/**
 * The two annual/periodic Intervat listings that are not the VAT return:
 *
 *  - **Client listing (`lc`)**: every Belgian VAT-registered customer you invoiced
 *    above the threshold, once a year, due 31 March.
 *  - **IC statement (`ico`)**: intra-EU supplies per customer per period.
 *
 * Both are built from the invoice sub-ledger rather than the GL, because both
 * report PER CUSTOMER and the GL deliberately does not carry a customer dimension
 * on every revenue line.
 *
 * XML shapes follow the official XSDs (NewLK-in_v0_9, NewICO-in_v0_9), validated
 * against them during the 2026-07 ACC test round.
 */
import type { PoolClient } from "pg";
import { LedgerError } from "./post.js";

export type ListingDeclarant = {
  vatNumber: string;
  name: string;
  street: string;
  postCode: string;
  city: string;
  countryCode?: string;
  email: string;
};

export type ClientListingRow = {
  customerName: string;
  vatNumber: string;
  turnover: number;
  vatAmount: number;
};

export type ClientListingResult = {
  year: number;
  rows: ClientListingRow[];
  turnoverSum: number;
  vatSum: number;
  warnings: string[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Normalise a Belgian VAT number to the 10 digits the XSD wants. */
function beVat(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 9) return `0${digits}`;
  return digits.length === 10 ? digits : null;
}

/**
 * Belgian customers above the threshold, with turnover and VAT for the year.
 * Customers without a usable VAT number are reported as warnings rather than
 * silently dropped — a missing listing line is a real compliance gap.
 */
export async function buildClientListing(
  client: { query: PoolClient["query"] },
  input: { teamId: string; year: number; threshold: number },
): Promise<ClientListingResult> {
  const r = await client.query(
    `SELECT c.name AS customer_name, c.vat_number, c.country,
            SUM(i.amount - COALESCE(i.vat, 0))::float8 AS turnover,
            SUM(COALESCE(i.vat, 0))::float8 AS vat_amount
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
      WHERE i.team_id = $1
        AND i.status NOT IN ('draft', 'canceled', 'scheduled')
        AND EXTRACT(YEAR FROM i.issue_date) = $2
      GROUP BY c.name, c.vat_number, c.country
      ORDER BY c.name`,
    [input.teamId, input.year],
  );

  const rows: ClientListingRow[] = [];
  const warnings: string[] = [];
  for (const row of r.rows) {
    const country = (row.country as string | null)?.toUpperCase() ?? null;
    const raw = (row.vat_number as string | null) ?? "";
    const turnover = r2(Number(row.turnover ?? 0));
    const vatAmount = r2(Number(row.vat_amount ?? 0));

    // Only Belgian VAT-registered customers belong on this listing.
    const isBelgian =
      country === null || country === "BE" || /^BE/i.test(raw.trim());
    if (!isBelgian) continue;
    if (turnover <= input.threshold) continue;

    const vat = beVat(raw);
    if (!vat) {
      warnings.push(
        `${row.customer_name}: EUR ${turnover.toFixed(2)} invoiced but no usable Belgian VAT number, so the customer is missing from the listing. Add it or confirm they are not VAT-registered.`,
      );
      continue;
    }
    rows.push({
      customerName: row.customer_name as string,
      vatNumber: vat,
      turnover,
      vatAmount,
    });
  }

  if (rows.length === 0 && warnings.length === 0) {
    warnings.push(
      `No Belgian customers above EUR ${input.threshold} in ${input.year}. A nil listing may still be required — confirm before skipping.`,
    );
  }
  return {
    year: input.year,
    rows,
    turnoverSum: r2(rows.reduce((s, x) => s + x.turnover, 0)),
    vatSum: r2(rows.reduce((s, x) => s + x.vatAmount, 0)),
    warnings,
  };
}

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function declarantXml(d: ListingDeclarant, indent: string): string {
  return [
    `${indent}<ns2:Declarant>`,
    `${indent}  <VATNumber>${d.vatNumber.replace(/\D/g, "")}</VATNumber>`,
    `${indent}  <Name>${esc(d.name)}</Name>`,
    `${indent}  <Street>${esc(d.street)}</Street>`,
    `${indent}  <PostCode>${esc(d.postCode)}</PostCode>`,
    `${indent}  <City>${esc(d.city)}</City>`,
    `${indent}  <CountryCode>${d.countryCode ?? "BE"}</CountryCode>`,
    `${indent}  <EmailAddress>${esc(d.email)}</EmailAddress>`,
    `${indent}</ns2:Declarant>`,
  ].join("\n");
}

/** ClientListingConsignment XML (declarationType `lc`). */
export function buildClientListingXml(input: {
  declarant: ListingDeclarant;
  listing: ClientListingResult;
  /** Set when replacing an earlier deposit: `<seq>-<vat>-<year>00`. */
  replaces?: string;
}): string {
  const { declarant, listing } = input;
  const clients = listing.rows
    .map((c, i) =>
      [
        `    <ns2:Client SequenceNumber="${i + 1}">`,
        `      <ns2:CompanyVATNumber issuedBy="BE">${c.vatNumber}</ns2:CompanyVATNumber>`,
        `      <ns2:TurnOver>${c.turnover.toFixed(2)}</ns2:TurnOver>`,
        `      <ns2:VATAmount>${c.vatAmount.toFixed(2)}</ns2:VATAmount>`,
        "    </ns2:Client>",
      ].join("\n"),
    )
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<ns2:ClientListingConsignment ClientListingsNbr="1" xmlns="http://www.minfin.fgov.be/InputCommon" xmlns:ns2="http://www.minfin.fgov.be/ClientListingConsignment">',
    `  <ns2:ClientListing SequenceNumber="1" ClientsNbr="${listing.rows.length}" TurnOverSum="${listing.turnoverSum.toFixed(2)}" VATAmountSum="${listing.vatSum.toFixed(2)}">`,
    input.replaces
      ? `    <ns2:ReplacedClientListing>${input.replaces}</ns2:ReplacedClientListing>`
      : null,
    declarantXml(declarant, "    "),
    `    <ns2:Period>${listing.year}</ns2:Period>`,
    clients || null,
    "  </ns2:ClientListing>",
    "</ns2:ClientListingConsignment>",
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export type IcRow = {
  customerName: string;
  /** Full EU VAT number without the country prefix. */
  vatNumber: string;
  countryCode: string;
  /** L = goods, S = services, T = triangular. */
  code: "L" | "S" | "T";
  amount: number;
};

export type IcStatementResult = {
  periodKey: string;
  rows: IcRow[];
  amountSum: number;
  warnings: string[];
};

/**
 * Intra-EU supplies per customer for a quarter or month.
 *
 * The L/S/T code cannot be derived from an invoice total: it depends on what was
 * supplied. Everything defaults to **S (services)** with a warning, because that
 * is what a one-person consultancy almost always files — but goods or triangular
 * trade must be corrected by hand before submitting.
 */
export async function buildIcStatement(
  client: { query: PoolClient["query"] },
  input: {
    teamId: string;
    year: number;
    quarter?: number;
    month?: number;
    defaultCode?: "L" | "S" | "T";
  },
): Promise<IcStatementResult> {
  const { year } = input;
  // Day 0 of the NEXT month is the last day of this one; hardcoding 31 produces
  // an invalid date for February and the short months.
  const monthEnd = (y: number, m: number): string =>
    new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const first = (y: number, m: number): string =>
    `${y}-${String(m).padStart(2, "0")}-01`;

  let from: string;
  let to: string;
  if (input.quarter) {
    const m = (input.quarter - 1) * 3 + 1;
    from = first(year, m);
    to = monthEnd(year, m + 2);
  } else if (input.month) {
    from = first(year, input.month);
    to = monthEnd(year, input.month);
  } else {
    throw new LedgerError("buildIcStatement needs a quarter or a month");
  }

  const r = await client.query(
    `SELECT c.name AS customer_name, c.vat_number, c.country,
            SUM(i.amount - COALESCE(i.vat, 0))::float8 AS amount
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
      WHERE i.team_id = $1
        AND i.status NOT IN ('draft', 'canceled', 'scheduled')
        AND i.issue_date >= $2::date AND i.issue_date <= $3::date
        AND c.vat_number IS NOT NULL
      GROUP BY c.name, c.vat_number, c.country
      ORDER BY c.name`,
    [input.teamId, from, to],
  );

  const rows: IcRow[] = [];
  const warnings: string[] = [];
  for (const row of r.rows) {
    const raw = ((row.vat_number as string) ?? "").trim().toUpperCase();
    const m = raw.match(/^([A-Z]{2})\s*(.+)$/);
    const country = m?.[1] ?? (row.country as string | null)?.toUpperCase() ?? "";
    const number = (m?.[2] ?? raw).replace(/[^A-Z0-9]/g, "");
    // Belgian customers belong on the client listing, not here.
    if (!country || country === "BE") continue;
    const amount = r2(Number(row.amount ?? 0));
    if (amount === 0) continue;
    rows.push({
      customerName: row.customer_name as string,
      vatNumber: number,
      countryCode: country,
      code: input.defaultCode ?? "S",
      amount,
    });
  }

  if (rows.length > 0) {
    warnings.push(
      `All ${rows.length} line(s) default to code ${input.defaultCode ?? "S"} (services). Correct any goods (L) or triangular (T) supplies before submitting.`,
    );
  }
  return {
    periodKey: input.quarter
      ? `${year}Q${input.quarter}`
      : `${year}M${String(input.month).padStart(2, "0")}`,
    rows,
    amountSum: r2(rows.reduce((s, x) => s + x.amount, 0)),
    warnings,
  };
}

/** IntraConsignment XML (declarationType `ico`). */
export function buildIcStatementXml(input: {
  declarant: ListingDeclarant;
  statement: IcStatementResult;
  replaces?: string;
}): string {
  const { declarant, statement } = input;
  const [yearStr, rest] = statement.periodKey.split(/[QM]/);
  const isQuarter = statement.periodKey.includes("Q");
  const periodInner = isQuarter
    ? `      <ns2:Quarter>${Number(rest)}</ns2:Quarter>`
    : `      <ns2:Month>${Number(rest)}</ns2:Month>`;

  const clients = statement.rows
    .map((c, i) =>
      [
        `    <ns2:IntraClient SequenceNumber="${i + 1}">`,
        `      <ns2:CompanyVATNumber issuedBy="${c.countryCode}">${c.vatNumber}</ns2:CompanyVATNumber>`,
        `      <ns2:Code>${c.code}</ns2:Code>`,
        `      <ns2:Amount>${c.amount.toFixed(2)}</ns2:Amount>`,
        "    </ns2:IntraClient>",
      ].join("\n"),
    )
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<ns2:IntraConsignment IntraListingsNbr="1" xmlns="http://www.minfin.fgov.be/InputCommon" xmlns:ns2="http://www.minfin.fgov.be/IntraConsignment">',
    `  <ns2:IntraListing SequenceNumber="1" ClientsNbr="${statement.rows.length}" AmountSum="${statement.amountSum.toFixed(2)}">`,
    input.replaces
      ? `    <ns2:ReplacedIntraListing>${input.replaces}</ns2:ReplacedIntraListing>`
      : null,
    declarantXml(declarant, "    "),
    "    <ns2:Period>",
    periodInner,
    `      <ns2:Year>${yearStr}</ns2:Year>`,
    "    </ns2:Period>",
    clients || null,
    "  </ns2:IntraListing>",
    "</ns2:IntraConsignment>",
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
}
