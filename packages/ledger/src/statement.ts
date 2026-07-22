/**
 * Financial statements (M7): the Belgian schema as grouped, multi-period
 * reads over the ledger. One engine drives the resultatenrekening (period-
 * bounded) and the balans (cumulative); sections are PCMN-prefix buckets,
 * longest prefix wins. Display convention follows the Belgian layout:
 * every section total is shown positive in its natural direction, result
 * lines are signed.
 */
import type { LedgerDb } from "./post.js";

type SectionDef = {
  key: string;
  label: string;
  /** PCMN code prefixes; longest match wins across ALL sections. */
  prefixes: string[];
  /** 'debit' shows debit balances positive; 'credit' the reverse. */
  direction: "debit" | "credit";
};

export const INCOME_SECTIONS: SectionDef[] = [
  {
    key: "opbrengsten",
    label: "Bedrijfsopbrengsten",
    prefixes: ["70", "74"],
    direction: "credit",
  },
  {
    key: "kosten",
    label: "Bedrijfskosten",
    prefixes: ["60", "61", "62", "63", "64"],
    direction: "debit",
  },
  {
    key: "fin_opbrengsten",
    label: "Financiële opbrengsten",
    prefixes: ["75"],
    direction: "credit",
  },
  {
    key: "fin_kosten",
    label: "Financiële kosten",
    prefixes: ["65"],
    direction: "debit",
  },
  {
    key: "uitzonderlijk",
    label: "Uitzonderlijk resultaat",
    prefixes: ["66", "76"],
    direction: "credit",
  },
  {
    key: "belastingen",
    label: "Belastingen op het resultaat",
    prefixes: ["67", "77"],
    direction: "debit",
  },
  // 69/79 (resultaatverwerking) deliberately included so historical years net
  // to their processed result inside the statement.
  {
    key: "verwerking",
    label: "Resultaatverwerking",
    prefixes: ["69", "79"],
    direction: "debit",
  },
];

export const BALANCE_SECTIONS: SectionDef[] = [
  {
    key: "vaste_activa",
    label: "Vaste activa",
    prefixes: ["2"],
    direction: "debit",
  },
  {
    key: "vorderingen",
    label: "Vorderingen en overlopende activa",
    prefixes: ["40", "41", "49"],
    direction: "debit",
  },
  {
    key: "liquide",
    label: "Liquide middelen",
    prefixes: ["5"],
    direction: "debit",
  },
  {
    key: "eigen_vermogen",
    label: "Eigen vermogen",
    prefixes: ["1"],
    direction: "credit",
  },
  {
    key: "schulden",
    label: "Schulden",
    prefixes: ["42", "43", "44", "45", "46", "47", "48"],
    direction: "credit",
  },
];

export type StatementPeriod = { from?: string; to: string; label: string };

export type StatementRow = { code: string; name: string; values: number[] };
export type StatementSection = {
  key: string;
  label: string;
  direction: "debit" | "credit";
  rows: StatementRow[];
  totals: number[];
};
export type StatementResult = {
  kind: "income" | "balance";
  periods: StatementPeriod[];
  sections: StatementSection[];
  /** income: winst/verlies van het boekjaar; balance: activa - passiva check (0). */
  result: number[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;

function matchSection(code: string, defs: SectionDef[]): SectionDef | null {
  let best: SectionDef | null = null;
  let bestLen = 0;
  for (const def of defs) {
    for (const p of def.prefixes) {
      if (code.startsWith(p) && p.length > bestLen) {
        best = def;
        bestLen = p.length;
      }
    }
  }
  return best;
}

export async function getStatement(
  client: LedgerDb,
  input: {
    teamId: string;
    kind: "income" | "balance";
    periods: StatementPeriod[];
  },
): Promise<StatementResult> {
  const defs = input.kind === "income" ? INCOME_SECTIONS : BALANCE_SECTIONS;

  // One bounded balance query per period; income statements bound both ends,
  // the balance sheet is cumulative-to-date.
  const perPeriod: Array<Map<string, { name: string; bal: number }>> = [];
  for (const p of input.periods) {
    const res = await client.query(
      `SELECT a.code, a.name, SUM(ll.debit - ll.credit)::float8 AS bal
         FROM ledger_lines ll
         JOIN journal_entries je ON je.id = ll.entry_id
          AND je.status IN ('posted', 'reversed')
         JOIN gl_accounts a ON a.id = ll.account_id
        WHERE ll.team_id = $1
          AND je.date >= COALESCE($2::date, '0001-01-01')
          AND je.date <= $3::date
        GROUP BY a.code, a.name`,
      [input.teamId, input.kind === "income" ? (p.from ?? null) : null, p.to],
    );
    const map = new Map<string, { name: string; bal: number }>();
    for (const row of res.rows)
      map.set(row.code, { name: row.name, bal: row.bal });
    perPeriod.push(map);
  }

  const allCodes = new Set<string>();
  for (const m of perPeriod) for (const code of m.keys()) allCodes.add(code);

  const sections: StatementSection[] = defs.map((d) => ({
    key: d.key,
    label: d.label,
    direction: d.direction,
    rows: [],
    totals: input.periods.map(() => 0),
  }));
  const byKey = new Map(sections.map((s) => [s.key, s]));

  for (const code of [...allCodes].sort()) {
    const def = matchSection(code, defs);
    if (!def) continue; // out-of-scope classes (e.g. P&L codes in a balance run)
    const section = byKey.get(def.key)!;
    const sign = def.direction === "credit" ? -1 : 1;
    const values = perPeriod.map((m) => r2((m.get(code)?.bal ?? 0) * sign));
    if (values.every((v) => v === 0)) continue;
    const name = perPeriod.find((m) => m.has(code))?.get(code)?.name ?? code;
    section.rows.push({ code, name, values });
    values.forEach((v, i) => {
      section.totals[i] = r2(section.totals[i]! + v);
    });
  }

  // Result line. Income: credits minus debits across every section EXCEPT the
  // resultaatverwerking (69/79) — processed years would otherwise net to zero;
  // the Belgian layout shows the pre-allocation result. Balance: the
  // unallocated P&L accumulation belongs to equity — reported as the
  // balancing "resultaat van het boekjaar".
  const result = input.periods.map((_, i) => {
    let total = 0;
    for (const s of sections) {
      if (s.key === "verwerking") continue;
      const sign = s.direction === "credit" ? 1 : -1;
      total += sign * s.totals[i]!;
    }
    return r2(total);
  });

  if (input.kind === "balance") {
    // activa(debit) - passiva(credit) = unbooked result (credit-natural):
    // show it inside eigen vermogen so the sheet balances visibly.
    const ev = byKey.get("eigen_vermogen")!;
    const unallocated = input.periods.map((_, i) => {
      let activa = 0;
      let passiva = 0;
      for (const s of sections) {
        if (s.direction === "debit") activa = r2(activa + s.totals[i]!);
        else passiva = r2(passiva + s.totals[i]!);
      }
      return r2(activa - passiva);
    });
    if (unallocated.some((v) => v !== 0)) {
      ev.rows.push({
        code: "—",
        name: "Resultaat van het boekjaar (nog niet verwerkt)",
        values: unallocated,
      });
      unallocated.forEach((v, i) => {
        ev.totals[i] = r2(ev.totals[i]! + v);
      });
    }
  }

  return { kind: input.kind, periods: input.periods, sections, result };
}

/** Friendly cost groups for the overview chart, longest prefix wins. */
export const COST_GROUPS: Array<{ label: string; prefixes: string[] }> = [
  { label: "Lonen & sociale lasten", prefixes: ["618", "6159"] },
  {
    label: "Mobiliteit & reizen",
    prefixes: [
      "6103",
      "6108",
      "6109",
      "611901",
      "6119",
      "613",
      "6144",
      "6145",
      "650001",
      "650002",
    ],
  },
  { label: "IT & materiaal", prefixes: ["6110", "6111", "6112"] },
  { label: "Huur & energie", prefixes: ["6100", "6101", "6102", "6116"] },
  { label: "Marketing & relaties", prefixes: ["612"] },
  { label: "Erelonen & advies", prefixes: ["6152", "6155", "6156", "6157"] },
  { label: "Verzekeringen", prefixes: ["614"] },
  { label: "Post & telecom", prefixes: ["616"] },
  { label: "Afschrijvingen", prefixes: ["63"] },
  { label: "Belastingen & bijdragen", prefixes: ["64", "67"] },
  { label: "Financieel & bankkosten", prefixes: ["65"] },
];

export type OverviewResult = {
  year: number;
  asOf: string;
  revenueYtd: number;
  revenuePrevYtd: number;
  costsYtd: number;
  costsPrevYtd: number;
  resultYtd: number;
  resultPrevYtd: number;
  bank: Array<{ code: string; name: string; balance: number }>;
  costGroups: Array<{ label: string; amount: number }>;
  vatQuarters: Array<{ quarter: number; deductible: number; payable: number }>;
};

export async function getOverview(
  client: LedgerDb,
  input: { teamId: string; year: number; asOf?: string },
): Promise<OverviewResult> {
  const today = input.asOf ?? new Date().toISOString().slice(0, 10);
  const asOf = today.startsWith(String(input.year))
    ? today
    : `${input.year}-12-31`;
  const prevAsOf = `${input.year - 1}${asOf.slice(4)}`;

  const pnl = async (from: string, to: string) => {
    const res = await client.query(
      `SELECT SUM(CASE WHEN a.code LIKE '7%' THEN ll.credit - ll.debit ELSE 0 END)::float8 AS revenue,
              SUM(CASE WHEN a.code LIKE '6%' THEN ll.debit - ll.credit ELSE 0 END)::float8 AS costs
         FROM ledger_lines ll
         JOIN journal_entries je ON je.id = ll.entry_id AND je.status IN ('posted','reversed')
         JOIN gl_accounts a ON a.id = ll.account_id
        WHERE ll.team_id = $1 AND je.date >= $2::date AND je.date <= $3::date`,
      [input.teamId, from, to],
    );
    return {
      revenue: r2(res.rows[0]?.revenue ?? 0),
      costs: r2(res.rows[0]?.costs ?? 0),
    };
  };
  const cur = await pnl(`${input.year}-01-01`, asOf);
  const prev = await pnl(`${input.year - 1}-01-01`, prevAsOf);

  const bank = await client.query(
    `SELECT a.code, a.name, ROUND(SUM(ll.debit - ll.credit)::numeric, 2)::float8 AS balance
       FROM ledger_lines ll
       JOIN journal_entries je ON je.id = ll.entry_id AND je.status IN ('posted','reversed')
       JOIN gl_accounts a ON a.id = ll.account_id
      WHERE ll.team_id = $1
        AND a.id IN (SELECT gl_account_id FROM journals
                      WHERE team_id = $1 AND bank_account_id IS NOT NULL)
      GROUP BY a.code, a.name ORDER BY a.code`,
    [input.teamId],
  );

  const costRows = await client.query(
    `SELECT a.code, SUM(ll.debit - ll.credit)::float8 AS bal
       FROM ledger_lines ll
       JOIN journal_entries je ON je.id = ll.entry_id AND je.status IN ('posted','reversed')
       JOIN gl_accounts a ON a.id = ll.account_id
      WHERE ll.team_id = $1 AND a.code LIKE '6%'
        AND je.date >= $2::date AND je.date <= $3::date
      GROUP BY a.code`,
    [input.teamId, `${input.year}-01-01`, asOf],
  );
  const groups = new Map<string, number>();
  for (const row of costRows.rows) {
    let label = "Diversen";
    let bestLen = 0;
    for (const g of COST_GROUPS) {
      for (const p of g.prefixes) {
        if (row.code.startsWith(p) && p.length > bestLen) {
          label = g.label;
          bestLen = p.length;
        }
      }
    }
    groups.set(label, r2((groups.get(label) ?? 0) + row.bal));
  }
  const costGroups = [...groups.entries()]
    .map(([label, amount]) => ({ label, amount }))
    .filter((g) => g.amount !== 0)
    .sort((a, b) => b.amount - a.amount);

  const vat = await client.query(
    `SELECT EXTRACT(QUARTER FROM je.date)::int AS q,
            SUM(CASE WHEN a.system_key = 'vat_deductible' THEN ll.debit - ll.credit ELSE 0 END)::float8 AS deductible,
            SUM(CASE WHEN a.system_key = 'vat_payable' THEN ll.credit - ll.debit ELSE 0 END)::float8 AS payable
       FROM ledger_lines ll
       JOIN journal_entries je ON je.id = ll.entry_id AND je.status IN ('posted','reversed')
       JOIN gl_accounts a ON a.id = ll.account_id
      WHERE ll.team_id = $1 AND a.system_key IN ('vat_deductible', 'vat_payable')
        AND je.date >= $2::date AND je.date <= $3::date
      GROUP BY 1 ORDER BY 1`,
    [input.teamId, `${input.year}-01-01`, `${input.year}-12-31`],
  );
  const vatQuarters = [1, 2, 3, 4].map((q) => {
    const row = vat.rows.find((r: { q: number }) => r.q === q);
    return {
      quarter: q,
      deductible: r2(row?.deductible ?? 0),
      payable: r2(row?.payable ?? 0),
    };
  });

  return {
    year: input.year,
    asOf,
    revenueYtd: cur.revenue,
    revenuePrevYtd: prev.revenue,
    costsYtd: cur.costs,
    costsPrevYtd: prev.costs,
    resultYtd: r2(cur.revenue - cur.costs),
    resultPrevYtd: r2(prev.revenue - prev.costs),
    bank: bank.rows,
    costGroups,
    vatQuarters,
  };
}
