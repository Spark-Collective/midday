/**
 * Belgian periodic VAT return: aggregate posted tax lines into the return's
 * boxes (roosters/grilles) and emit the Intervat VATConsignment XML that
 * spark-minfin `vat submit` files.
 *
 * Grid mappings were verified against the accounting-kb
 * (concepts/vat/vat-return-grilles.md, 2026-07-20). That page is verify_live:
 * every generated return carries a warning to confirm boxes/deadlines against
 * the current FOD Financiën form before filing (2025 changed the current
 * account to a provisierekening and moved the quarterly deadline to the 25th).
 *
 * Direction-aware per S7: credit notes report in their own boxes (49/64 issued,
 * 84/85/63 received), never netted into the invoice grids. Coded lines use
 * tax_codes.grids; uncoded purchase VAT (the bank-transaction path) falls back
 * to the Belgian account-class heuristic: 60x -> 81, 2xx -> 83, else 82.
 */
import { type LedgerDb, LedgerError } from "./post.js";

export type VatPeriod = { year: number; quarter?: number; month?: number };

export type VatDeclarant = {
  vatNumber: string; // 10 digits
  name: string;
  street: string;
  postCode: string;
  city: string;
  countryCode?: string;
  email: string;
};

export type VatReturnResult = {
  period: VatPeriod;
  /** Box -> amount (2-decimal string), zero boxes omitted. */
  grids: Record<string, string>;
  xml: string;
  warnings: string[];
};

type GridsShape = {
  invoice?: { base?: string[]; tax?: string[] };
  creditNote?: { base?: string[]; tax?: string[] };
};

const c = (v: number | string): number => Math.round(Number(v) * 100);

function periodRange(p: VatPeriod): { from: string; to: string } {
  if (p.quarter) {
    const m0 = (p.quarter - 1) * 3 + 1;
    const end = new Date(Date.UTC(p.year, m0 + 2, 0)).getUTCDate();
    return {
      from: `${p.year}-${String(m0).padStart(2, "0")}-01`,
      to: `${p.year}-${String(m0 + 2).padStart(2, "0")}-${end}`,
    };
  }
  if (p.month) {
    const end = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
    const mm = String(p.month).padStart(2, "0");
    return { from: `${p.year}-${mm}-01`, to: `${p.year}-${mm}-${end}` };
  }
  throw new LedgerError("vat period needs a quarter or a month");
}

/** Belgian purchase-base heuristic by PCMN class (KB: 81 goods, 82 services, 83 investments). */
function purchaseBaseGrid(accountCode: string): string {
  if (accountCode.startsWith("60")) return "81";
  if (accountCode.startsWith("2")) return "83";
  return "82";
}

/** Grids + warnings only (no XML) — what the dashboard shows. */
export async function computeVatGrids(
  client: LedgerDb,
  input: { teamId: string; period: VatPeriod },
): Promise<{ grids: Record<string, string>; warnings: string[] }> {
  const { from, to } = periodRange(input.period);
  const warnings: string[] = [
    "Verify boxes and deadline against the current FOD Financien form before filing (accounting-kb: vat-return-grilles is verify_live; 2025 moved quarterly filing to the 25th).",
  ];
  const grids = new Map<string, number>(); // box -> cents

  const add = (box: string | undefined, centsVal: number) => {
    if (!box || centsVal === 0) return;
    grids.set(box, (grids.get(box) ?? 0) + centsVal);
  };

  // 1. Coded lines: base lines feed grid.base, tax-account lines feed grid.tax.
  const coded = await client.query(
    `SELECT ll.debit, ll.credit, a.type AS account_type, a.system_key,
            t.code AS tax_code, t.grids, t.verified
       FROM ledger_lines ll
       JOIN journal_entries je ON je.id = ll.entry_id AND je.status = 'posted'
       JOIN gl_accounts a ON a.id = ll.account_id
       JOIN tax_codes t ON t.id = ll.tax_code_id
      WHERE ll.team_id = $1 AND je.date BETWEEN $2 AND $3`,
    [input.teamId, from, to],
  );
  const unverified = new Set<string>();
  for (const r of coded.rows) {
    const g = (r.grids ?? {}) as GridsShape;
    if (!r.verified) unverified.add(r.tax_code);
    const isTaxLine =
      r.system_key === "vat_payable" || r.system_key === "vat_deductible";
    const debit = c(r.debit);
    const credit = c(r.credit);
    // Direction: the natural side of the code's document. Sales bases live on
    // income accounts (credit = invoice); purchase bases and all tax lines on
    // vat_deductible are debit-natural; vat_payable is credit-natural.
    const naturalCredit =
      r.account_type === "income" || r.system_key === "vat_payable";
    const direction = (naturalCredit ? credit > 0 : debit > 0)
      ? "invoice"
      : "creditNote";
    const amount = debit > 0 ? debit : credit;
    const boxes = isTaxLine ? g[direction]?.tax : g[direction]?.base;
    for (const box of boxes ?? []) add(box, amount);
  }
  if (unverified.size > 0) {
    warnings.push(
      `Tax codes with UNVERIFIED grid mappings used: ${[...unverified].join(", ")}.`,
    );
  }

  // 2. Uncoded VAT on vat_deductible (bank-transaction posting): tax -> 59
  //    (or 63 for refunds), base -> 81/82/83 by the cost line's account class.
  const uncoded = await client.query(
    `SELECT ll.entry_id, ll.debit, ll.credit, ll.tax_base,
            (SELECT a2.code FROM ledger_lines ll2
               JOIN gl_accounts a2 ON a2.id = ll2.account_id
              WHERE ll2.entry_id = ll.entry_id AND ll2.id <> ll.id
                AND a2.system_key IS NULL
                AND ((ll.debit > 0 AND ll2.debit > 0) OR (ll.credit > 0 AND ll2.credit > 0))
              ORDER BY GREATEST(ll2.debit, ll2.credit) DESC LIMIT 1) AS cost_code
       FROM ledger_lines ll
       JOIN journal_entries je ON je.id = ll.entry_id AND je.status = 'posted'
       JOIN gl_accounts a ON a.id = ll.account_id
      WHERE ll.team_id = $1 AND je.date BETWEEN $2 AND $3
        AND a.system_key = 'vat_deductible' AND ll.tax_code_id IS NULL`,
    [input.teamId, from, to],
  );
  for (const r of uncoded.rows) {
    const isRefund = c(r.credit) > 0;
    add(isRefund ? "63" : "59", isRefund ? c(r.credit) : c(r.debit));
    const baseBox = isRefund ? "85" : purchaseBaseGrid(r.cost_code ?? "61");
    add(baseBox, c(r.tax_base ?? 0));
  }
  if ((uncoded.rowCount ?? 0) > 0) {
    warnings.push(
      `${uncoded.rowCount} uncoded purchase VAT line(s) mapped heuristically (81/82/83 by account class).`,
    );
  }

  // 3. Zero-rated sales without a tax code cannot be assigned a box.
  const unmapped = await client.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(ll.credit - ll.debit), 0) AS amount
       FROM ledger_lines ll
       JOIN journal_entries je ON je.id = ll.entry_id
         AND je.status = 'posted' AND je.source_type = 'invoice'
       JOIN gl_accounts a ON a.id = ll.account_id
      WHERE ll.team_id = $1 AND je.date BETWEEN $2 AND $3
        AND a.type = 'income' AND ll.tax_code_id IS NULL`,
    [input.teamId, from, to],
  );
  if (unmapped.rows[0].n > 0) {
    warnings.push(
      `${unmapped.rows[0].n} zero-rated sales line(s) without a tax code (EUR ${Number(unmapped.rows[0].amount).toFixed(2)}) are NOT in any box — assign V00-ICS / V00-EXP and re-post.`,
    );
  }

  // 4. Balance: 71 (to pay) / 72 (refundable). Formula per the official form:
  //    total due (54,55,56,57,61,63) minus total deductible (59,62,64).
  const due = ["54", "55", "56", "57", "61", "63"].reduce(
    (s, b) => s + (grids.get(b) ?? 0),
    0,
  );
  const deductible = ["59", "62", "64"].reduce(
    (s, b) => s + (grids.get(b) ?? 0),
    0,
  );
  if (due - deductible > 0) grids.set("71", due - deductible);
  else if (deductible - due > 0) grids.set("72", deductible - due);

  const out: Record<string, string> = {};
  for (const [box, v] of [...grids.entries()].sort(
    ([a], [b]) => Number(a) - Number(b),
  )) {
    if (v !== 0) out[box] = (v / 100).toFixed(2);
  }
  return { grids: out, warnings };
}

export async function generateVatReturn(
  client: LedgerDb,
  input: {
    teamId: string;
    period: VatPeriod;
    declarant: VatDeclarant;
    /** ClientListingNihil flag for the XML, default "NO". */
    clientListingNihil?: "YES" | "NO";
    askRestitution?: "YES" | "NO";
  },
): Promise<VatReturnResult> {
  const { grids, warnings } = await computeVatGrids(client, input);
  return {
    period: input.period,
    grids,
    xml: buildVatConsignmentXml(input, grids),
    warnings,
  };
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildVatConsignmentXml(
  input: {
    period: VatPeriod;
    declarant: VatDeclarant;
    clientListingNihil?: "YES" | "NO";
    askRestitution?: "YES" | "NO";
  },
  grids: Record<string, string>,
): string {
  const d = input.declarant;
  const vat = d.vatNumber.replace(/\D/g, "");
  if (!/^[0-1][0-9]{9}$/.test(vat)) {
    throw new LedgerError(
      `declarant vatNumber must be 10 digits (got '${d.vatNumber}')`,
    );
  }
  const periodXml = input.period.quarter
    ? `<ns2:Quarter>${input.period.quarter}</ns2:Quarter>`
    : `<ns2:Month>${input.period.month}</ns2:Month>`;
  const amounts = Object.entries(grids)
    // 71/72 are computed by Intervat from the other boxes; sending them is
    // allowed, and keeping them makes the file self-describing.
    .map(
      ([box, v]) => `      <ns2:Amount GridNumber="${box}">${v}</ns2:Amount>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ns2:VATConsignment VATDeclarationsNbr="1"
    xmlns="http://www.minfin.fgov.be/InputCommon"
    xmlns:ns2="http://www.minfin.fgov.be/VATConsignment">
  <ns2:VATDeclaration SequenceNumber="1">
    <ns2:Declarant>
      <VATNumber>${vat}</VATNumber>
      <Name>${esc(d.name)}</Name>
      <Street>${esc(d.street)}</Street>
      <PostCode>${esc(d.postCode)}</PostCode>
      <City>${esc(d.city)}</City>
      <CountryCode>${d.countryCode ?? "BE"}</CountryCode>
      <EmailAddress>${esc(d.email)}</EmailAddress>
    </ns2:Declarant>
    <ns2:Period>
      ${periodXml}
      <ns2:Year>${input.period.year}</ns2:Year>
    </ns2:Period>
    <ns2:Data>
${amounts}
    </ns2:Data>
    <ns2:ClientListingNihil>${input.clientListingNihil ?? "NO"}</ns2:ClientListingNihil>
    <ns2:Ask Restitution="${input.askRestitution ?? "NO"}"/>
  </ns2:VATDeclaration>
</ns2:VATConsignment>
`;
}
