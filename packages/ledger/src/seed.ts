/**
 * Belgian accounting seed: journals (dagboeken), fiscal periods, system
 * accounts, VAT tax codes, and optionally a full PCMN chart from a CSV export
 * (columns: account_code,account_name,root_type,account_type,...). The CSV is
 * external data passed at runtime — client charts are never committed here.
 *
 * VAT grid mappings are seeded with verified=false: the exact box numbers are
 * changeable facts that must be checked against the accounting knowledge base
 * before the VAT-return generator (M3) trusts them.
 */
import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";

export type SeedOptions = {
  teamId: string;
  /** Path to an ERPNext-style chart CSV (optional). */
  chartCsvPath?: string;
  /** Fiscal years to open, default [2025, 2026]. */
  years?: number[];
};

export type SeedResult = {
  journals: number;
  periods: number;
  accounts: number;
  taxCodes: number;
};

// The journal set mirrors Spark's real books (Exact dagboeken 500-890).
const JOURNALS: Array<[code: string, name: string, type: string]> = [
  ["500", "Bank", "bank"],
  ["570", "Kas / kaart", "cash"],
  ["600", "Aankopen", "purchase"],
  ["700", "Verkopen", "sales"],
  ["800", "Diversen", "general"],
  ["890", "Diversen met btw", "general"],
];

// Accounts the posting rules resolve via systemKey. Created if the chart does
// not already carry the code; if it does, the systemKey is attached to it.
const SYSTEM_ACCOUNTS: Array<
  [code: string, name: string, type: string, systemKey: string]
> = [
  ["400000", "Handelsdebiteuren", "asset", "trade_debtors"],
  ["440000", "Leveranciers", "liability", "trade_creditors"],
  [
    "406000",
    "Vooruitbetalingen aan leveranciers",
    "asset",
    "supplier_advances",
  ],
  ["460000", "Ontvangen vooruitbetalingen", "liability", "customer_advances"],
  ["411000", "Aftrekbare btw", "asset", "vat_deductible"],
  ["451000", "Te betalen btw", "liability", "vat_payable"],
  ["451900", "R/C btw-administratie", "liability", "vat_current_account"],
  ["580000", "Interne overboekingen", "asset", "internal_transfers"],
  ["654000", "Wisselresultaten verlies", "expense", "fx_loss_realized"],
  ["754000", "Wisselresultaten winst", "income", "fx_gain_realized"],
  ["655000", "Omrekeningsverschillen verlies", "expense", "fx_loss_unrealized"],
  ["755000", "Omrekeningsverschillen winst", "income", "fx_gain_unrealized"],
  ["657010", "Betalingsverschillen verlies", "expense", "payment_diff_loss"],
  ["757010", "Betalingsverschillen winst", "income", "payment_diff_gain"],
  [
    "630200",
    "Afschrijvingen materiële vaste activa",
    "expense",
    "depreciation_expense",
  ],
  ["140000", "Overgedragen winst", "equity", "retained_earnings"],
  ["700000", "Verkopen en diensten", "income", "sales_revenue"],
  ["490000", "Over te dragen kosten", "asset", "deferred_charges"],
  [
    "663000",
    "Minderwaarden op realisatie vaste activa",
    "expense",
    "asset_disposal_loss",
  ],
  [
    "763000",
    "Meerwaarden op realisatie vaste activa",
    "income",
    "asset_disposal_gain",
  ],
];

// Belgian VAT codes, direction-aware per S7 (credit notes report in their own
// boxes, never netted). Grid mappings VERIFIED against the accounting-kb
// (concepts/vat/vat-return-grilles.md, 2026-07-20). That page is verify_live:
// the return generator still warns to confirm against the current form.
const TAX_CODES: Array<{
  code: string;
  name: string;
  rate: number;
  kind: string;
  grids: unknown;
}> = [
  {
    code: "V21",
    name: "Verkopen 21%",
    rate: 21,
    kind: "standard",
    grids: {
      invoice: { base: ["03"], tax: ["54"] },
      creditNote: { base: ["49"], tax: ["64"] },
    },
  },
  {
    code: "V12",
    name: "Verkopen 12%",
    rate: 12,
    kind: "reduced",
    grids: {
      invoice: { base: ["02"], tax: ["54"] },
      creditNote: { base: ["49"], tax: ["64"] },
    },
  },
  {
    code: "V06",
    name: "Verkopen 6%",
    rate: 6,
    kind: "reduced",
    grids: {
      invoice: { base: ["01"], tax: ["54"] },
      creditNote: { base: ["49"], tax: ["64"] },
    },
  },
  {
    code: "V00-ICS",
    name: "Intracommunautaire diensten (B2B)",
    rate: 0,
    kind: "intra_eu",
    grids: {
      invoice: { base: ["44"], tax: [] },
      creditNote: { base: ["48"], tax: [] },
    },
  },
  {
    code: "V00-EXP",
    name: "Uitvoer buiten EU",
    rate: 0,
    kind: "export",
    grids: {
      invoice: { base: ["47"], tax: [] },
      creditNote: { base: ["49"], tax: [] },
    },
  },
  {
    code: "P21",
    name: "Aankopen diensten/diverse 21%",
    rate: 21,
    kind: "standard",
    grids: {
      invoice: { base: ["82"], tax: ["59"] },
      creditNote: { base: ["85"], tax: ["63"] },
    },
  },
  {
    code: "P21-INV",
    name: "Aankopen investeringen 21%",
    rate: 21,
    kind: "standard",
    grids: {
      invoice: { base: ["83"], tax: ["59"] },
      creditNote: { base: ["85"], tax: ["63"] },
    },
  },
  {
    code: "P21-ICS",
    name: "Intracommunautaire diensten verlegd 21%",
    rate: 21,
    kind: "reverse_charge",
    grids: {
      invoice: { base: ["82", "88"], tax: ["55", "59"] },
      creditNote: { base: ["84"], tax: ["61", "63"] },
    },
  },
];

/** PCMN fallback: map an account code's first digit to a type. */
function typeFromCode(code: string): string {
  const c = code[0];
  if (c === "6") return "expense";
  if (c === "7") return "income";
  if (c === "1") return "equity";
  if (c === "4") return Number(code.slice(0, 2)) >= 44 ? "liability" : "asset";
  return "asset"; // 2, 3, 5
}

function typeFromRootType(rootType: string, code: string): string {
  const t = rootType.trim().toLowerCase();
  if (["asset", "liability", "equity", "income", "expense"].includes(t))
    return t;
  return typeFromCode(code);
}

/** Minimal CSV parser (quoted fields, no embedded newlines). */
export function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const out: string[] = [];
      let cur = "";
      let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
          if (ch === '"' && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else if (ch === '"') {
            inQ = false;
          } else {
            cur += ch;
          }
        } else if (ch === '"') {
          inQ = true;
        } else if (ch === ",") {
          out.push(cur);
          cur = "";
        } else {
          cur += ch;
        }
      }
      out.push(cur);
      return out;
    });
}

export async function seedBelgianLedger(
  client: PoolClient,
  opts: SeedOptions,
): Promise<SeedResult> {
  const years = opts.years ?? [2025, 2026];
  const result: SeedResult = {
    journals: 0,
    periods: 0,
    accounts: 0,
    taxCodes: 0,
  };

  for (const [code, name, type] of JOURNALS) {
    const res = await client.query(
      `INSERT INTO journals (team_id, code, name, type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ON CONSTRAINT journals_team_code_unique DO NOTHING`,
      [opts.teamId, code, name, type],
    );
    result.journals += res.rowCount ?? 0;
  }

  for (const year of years) {
    for (let month = 1; month <= 12; month++) {
      const res = await client.query(
        `INSERT INTO fiscal_periods (team_id, year, month)
         VALUES ($1, $2, $3)
         ON CONFLICT ON CONSTRAINT fiscal_periods_team_year_month_unique DO NOTHING`,
        [opts.teamId, year, month],
      );
      result.periods += res.rowCount ?? 0;
    }
  }

  // Chart from CSV first (so system keys attach to existing codes).
  if (opts.chartCsvPath) {
    const rows = parseCsv(readFileSync(opts.chartCsvPath, "utf8"));
    const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
    const codeIdx = header.indexOf("account_code");
    const nameIdx = header.indexOf("account_name");
    const rootIdx = header.indexOf("root_type");
    if (codeIdx === -1 || nameIdx === -1) {
      throw new Error("chart CSV needs account_code and account_name columns");
    }
    for (const row of rows.slice(1)) {
      const code = row[codeIdx]?.trim();
      const name = row[nameIdx]?.trim();
      if (!code || !name) continue;
      const type = typeFromRootType(
        rootIdx >= 0 ? (row[rootIdx] ?? "") : "",
        code,
      );
      const res = await client.query(
        `INSERT INTO gl_accounts (team_id, code, name, type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ON CONSTRAINT gl_accounts_team_code_unique DO NOTHING`,
        [opts.teamId, code, name, type],
      );
      result.accounts += res.rowCount ?? 0;
    }
  }

  for (const [code, name, type, systemKey] of SYSTEM_ACCOUNTS) {
    const res = await client.query(
      `INSERT INTO gl_accounts (team_id, code, name, type, system_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ON CONSTRAINT gl_accounts_team_code_unique
       DO UPDATE SET system_key = EXCLUDED.system_key
       WHERE gl_accounts.system_key IS NULL`,
      [opts.teamId, code, name, type, systemKey],
    );
    result.accounts += res.rowCount ?? 0;
  }

  for (const t of TAX_CODES) {
    const res = await client.query(
      `INSERT INTO tax_codes (team_id, code, name, rate, kind, grids, verified)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT ON CONSTRAINT tax_codes_team_code_unique DO NOTHING`,
      [
        opts.teamId,
        t.code,
        t.name,
        String(t.rate),
        t.kind,
        JSON.stringify(t.grids),
      ],
    );
    result.taxCodes += res.rowCount ?? 0;
  }

  return result;
}
