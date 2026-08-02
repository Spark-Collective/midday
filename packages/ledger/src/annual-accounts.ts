/**
 * Annual accounts (M9): map ledger balances to the NBB micro-model
 * rubrieken (m87-f, vennootschap zonder kapitaal). Pure PCMN-prefix
 * bucketing like the statement engine; both the balance sheet (cumulative)
 * and the micro income statement (period-bounded, brutomarge form) with the
 * arithmetic controls the Balanscentrale enforces. The XBRL serialization
 * lives in annual-accounts-xbrl.ts; filing itself stays a human act.
 */
import type { LedgerDb } from "./post.js";

export type Rubriek = {
  code: string;
  label: string;
  /** EUR, natural-positive per the official model; result codes are signed. */
  values: number[]; // one per requested year, current first
};

export type AnnualAccounts = {
  years: number[];
  balans: { activa: Rubriek[]; passiva: Rubriek[] };
  resultatenrekening: Rubriek[];
  resultaatverwerking: Rubriek[];
  /** Balanscentrale-style arithmetic controls; all must be true to file. */
  checks: Array<{ name: string; ok: boolean; detail: string }>;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Sum of (debit - credit) for accounts matching any prefix. */
type Sums = Map<string, number>; // account code -> net (debit - credit)

function pick(sums: Sums, prefixes: string[], sign: 1 | -1 = 1): number {
  let total = 0;
  for (const [code, net] of sums) {
    if (prefixes.some((p) => code.startsWith(p))) total += net;
  }
  return r2(sign * total);
}

async function loadSums(
  client: LedgerDb,
  teamId: string,
  from: string | null,
  to: string,
): Promise<Sums> {
  const res = await client.query(
    `SELECT a.code, SUM(ll.debit - ll.credit)::float8 AS net
       FROM ledger_lines ll
       JOIN journal_entries je ON je.id = ll.entry_id
        AND je.status IN ('posted', 'reversed')
       JOIN gl_accounts a ON a.id = ll.account_id
      WHERE ll.team_id = $1
        AND je.date >= COALESCE($2::date, '0001-01-01')
        AND je.date <= $3::date
      GROUP BY a.code`,
    [teamId, from, to],
  );
  const map: Sums = new Map();
  for (const row of res.rows) map.set(row.code, row.net);
  return map;
}

export async function getAnnualAccounts(
  client: LedgerDb,
  input: { teamId: string; year: number; compareYear?: number },
): Promise<AnnualAccounts> {
  const years = [input.year];
  if (input.compareYear) years.push(input.compareYear);

  // balance sheet: cumulative; income statement: bounded to the year
  const bal: Sums[] = [];
  const pnl: Sums[] = [];
  for (const y of years) {
    bal.push(await loadSums(client, input.teamId, null, `${y}-12-31`));
    pnl.push(await loadSums(client, input.teamId, `${y}-01-01`, `${y}-12-31`));
  }

  const rub = (
    code: string,
    label: string,
    calc: (b: Sums, p: Sums) => number,
  ): Rubriek => ({
    code,
    label,
    values: years.map((_, i) => calc(bal[i]!, pnl[i]!)),
  });

  // ---------------- Balans (micro model, WVV vennootschap zonder kapitaal)
  const activa: Rubriek[] = [
    rub("20", "Oprichtingskosten", (b) => pick(b, ["20"])),
    rub("21", "Immateriële vaste activa", (b) => pick(b, ["21"])),
    rub("22/27", "Materiële vaste activa", (b) =>
      pick(b, ["22", "23", "24", "25", "26", "27"]),
    ),
    rub("28", "Financiële vaste activa", (b) => pick(b, ["28"])),
    rub("21/28", "Vaste activa", (b) =>
      r2(pick(b, ["21"]) + pick(b, ["22", "23", "24", "25", "26", "27"]) + pick(b, ["28"])),
    ),
    rub("29", "Vorderingen op meer dan één jaar", (b) => pick(b, ["29"])),
    rub("3", "Voorraden en bestellingen in uitvoering", (b) => pick(b, ["3"])),
    rub("40/41", "Vorderingen op ten hoogste één jaar", (b) =>
      pick(b, ["40", "41"]),
    ),
    rub("50/53", "Geldbeleggingen", (b) => pick(b, ["50", "51", "52", "53"])),
    rub("54/58", "Liquide middelen", (b) =>
      pick(b, ["54", "55", "56", "57", "58"]),
    ),
    rub("490/1", "Overlopende rekeningen (actief)", (b) => pick(b, ["490", "491"])),
    rub("29/58", "Vlottende activa", (b) =>
      r2(
        pick(b, ["29", "3", "40", "41", "50", "51", "52", "53", "54", "55", "56", "57", "58", "490", "491"]),
      ),
    ),
    rub("20/58", "TOTAAL ACTIVA", (b) =>
      r2(
        pick(b, ["20", "21", "22", "23", "24", "25", "26", "27", "28"]) +
          pick(b, ["29", "3", "40", "41", "50", "51", "52", "53", "54", "55", "56", "57", "58", "490", "491"]),
      ),
    ),
  ];

  // Passiva are credit-natural (sign -1). The unallocated current-year result
  // stays inside 14 only after resultaatverwerking; before processing the
  // ledger carries it implicitly (activa - passiva), so 14 is derived as the
  // balancing figure when 69/79 have not been booked yet.
  const passivaBooked = (b: Sums) =>
    r2(
      pick(b, ["10", "11", "12", "13", "14", "15"], -1) +
        pick(b, ["16"], -1) +
        pick(b, ["17"], -1) +
        pick(b, ["42", "43", "44", "45", "46", "47", "48"], -1) +
        pick(b, ["492", "493"], -1),
    );
  const totalActiva = (b: Sums) =>
    r2(
      pick(b, ["20", "21", "22", "23", "24", "25", "26", "27", "28"]) +
        pick(b, ["29", "3", "40", "41", "50", "51", "52", "53", "54", "55", "56", "57", "58", "490", "491"]),
    );
  /** Result not yet processed to 14 (zero once 693/793 are booked). */
  const unallocated = (b: Sums) => r2(totalActiva(b) - passivaBooked(b));

  const passiva: Rubriek[] = [
    rub("10/11", "Inbreng", (b) => pick(b, ["10", "11"], -1)),
    rub("12", "Herwaarderingsmeerwaarden", (b) => pick(b, ["12"], -1)),
    rub("13", "Reserves", (b) => pick(b, ["13"], -1)),
    rub("14", "Overgedragen winst (verlies)", (b) =>
      r2(pick(b, ["14"], -1) + unallocated(b)),
    ),
    rub("15", "Kapitaalsubsidies", (b) => pick(b, ["15"], -1)),
    rub("10/15", "EIGEN VERMOGEN", (b) =>
      r2(pick(b, ["10", "11", "12", "13", "14", "15"], -1) + unallocated(b)),
    ),
    rub("16", "Voorzieningen en uitgestelde belastingen", (b) => pick(b, ["16"], -1)),
    rub("17", "Schulden op meer dan één jaar", (b) => pick(b, ["17"], -1)),
    rub("42/48", "Schulden op ten hoogste één jaar", (b) =>
      pick(b, ["42", "43", "44", "45", "46", "47", "48"], -1),
    ),
    rub("492/3", "Overlopende rekeningen (passief)", (b) =>
      pick(b, ["492", "493"], -1),
    ),
    rub("17/49", "SCHULDEN", (b) =>
      r2(
        pick(b, ["16"], -1) +
          pick(b, ["17"], -1) +
          pick(b, ["42", "43", "44", "45", "46", "47", "48"], -1) +
          pick(b, ["492", "493"], -1),
      ),
    ),
    rub("10/49", "TOTAAL PASSIVA", (b) => r2(passivaBooked(b) + unallocated(b))),
  ];

  // ---------------- Resultatenrekening (micro: brutomarge form)
  // 9900 = bedrijfsopbrengsten (70/74, 76A) - handelsgoederen (60) -
  //        diensten en diverse goederen (61)
  const opbrengsten = (p: Sums) =>
    pick(p, ["70", "71", "72", "74", "76"], -1); // 76A: niet-recurrente bedrijfsopbrengsten
  const rr: Rubriek[] = [
    rub("9900", "Brutomarge", (_b, p) =>
      r2(opbrengsten(p) - pick(p, ["60"]) - pick(p, ["61"])),
    ),
    rub("62", "Bezoldigingen, sociale lasten en pensioenen", (_b, p) =>
      pick(p, ["62"]),
    ),
    rub("630", "Afschrijvingen en waardeverminderingen op vaste activa", (_b, p) =>
      pick(p, ["630"]),
    ),
    rub("631/4", "Waardeverminderingen op voorraden en vorderingen", (_b, p) =>
      pick(p, ["631", "632", "633", "634"]),
    ),
    rub("635/8", "Voorzieningen voor risico's en kosten", (_b, p) =>
      pick(p, ["635", "636", "637", "638"]),
    ),
    rub("640/8", "Andere bedrijfskosten", (_b, p) =>
      pick(p, ["640", "641", "642", "643", "644", "645", "646", "647", "648"]),
    ),
    rub("649", "Geactiveerde bedrijfskosten (-)", (_b, p) => pick(p, ["649"], -1)),
    rub("9901", "Bedrijfswinst (Bedrijfsverlies)", (_b, p) =>
      r2(
        opbrengsten(p) -
          pick(p, ["60"]) -
          pick(p, ["61"]) -
          pick(p, ["62"]) -
          pick(p, ["63"]) -
          pick(p, ["640", "641", "642", "643", "644", "645", "646", "647", "648"]) +
          pick(p, ["649"], -1),
      ),
    ),
    rub("75/76B", "Financiële opbrengsten", (_b, p) => pick(p, ["75"], -1)),
    rub("65/66B", "Financiële kosten", (_b, p) => pick(p, ["65", "66"])),
    rub("9903", "Winst (Verlies) van het boekjaar vóór belasting", (_b, p) =>
      r2(
        opbrengsten(p) -
          pick(p, ["60"]) -
          pick(p, ["61"]) -
          pick(p, ["62"]) -
          pick(p, ["63"]) -
          pick(p, ["640", "641", "642", "643", "644", "645", "646", "647", "648"]) +
          pick(p, ["649"], -1) +
          pick(p, ["75"], -1) -
          pick(p, ["65", "66"]),
      ),
    ),
    rub("67/77", "Belastingen op het resultaat", (_b, p) =>
      r2(pick(p, ["67"]) - pick(p, ["77"], -1)),
    ),
    rub("9904", "Winst (Verlies) van het boekjaar", (_b, p) =>
      r2(
        opbrengsten(p) -
          pick(p, ["60"]) -
          pick(p, ["61"]) -
          pick(p, ["62"]) -
          pick(p, ["63"]) -
          pick(p, ["640", "641", "642", "643", "644", "645", "646", "647", "648"]) +
          pick(p, ["649"], -1) +
          pick(p, ["75"], -1) -
          pick(p, ["65", "66"]) -
          pick(p, ["67"]) +
          pick(p, ["77"], -1),
      ),
    ),
  ];

  // ---------------- Resultaatverwerking
  const winst = (p: Sums) =>
    rr.find((x) => x.code === "9904")!.values[pnl.indexOf(p)]!;
  const verwerking: Rubriek[] = [
    rub("9905", "Te bestemmen winst (verlies)", (_b, p) =>
      r2(winst(p) + pick(p, ["790"], -1) - pick(p, ["690"])),
    ),
    rub("14P", "Over te dragen winst (verlies)", (_b, p) =>
      // what 693/793 booked; if the year is not yet processed this equals 0
      r2(pick(p, ["693"]) - pick(p, ["793"], -1)),
    ),
  ];

  // ---------------- Controls
  const checks: AnnualAccounts["checks"] = [];
  const val = (list: Rubriek[], code: string, i = 0) =>
    list.find((x) => x.code === code)?.values[i] ?? 0;
  for (let i = 0; i < years.length; i++) {
    const ta = val(activa, "20/58", i);
    const tp = val(passiva, "10/49", i);
    checks.push({
      name: `balans ${years[i]}`,
      ok: Math.abs(ta - tp) < 0.005,
      detail: `activa ${ta.toFixed(2)} vs passiva ${tp.toFixed(2)}`,
    });
    const ev = val(passiva, "10/15", i);
    const sch = val(passiva, "17/49", i);
    checks.push({
      name: `passiva-opbouw ${years[i]}`,
      ok: Math.abs(ev + sch - tp) < 0.005,
      detail: `10/15 (${ev.toFixed(2)}) + 17/49 (${sch.toFixed(2)}) = ${tp.toFixed(2)}`,
    });
    const w9901 = val(rr, "9901", i);
    const w9903 = val(rr, "9903", i);
    const fin = val(rr, "75/76B", i) - val(rr, "65/66B", i);
    checks.push({
      name: `resultaat-opbouw ${years[i]}`,
      ok: Math.abs(w9901 + fin - w9903) < 0.005,
      detail: `9901 (${w9901.toFixed(2)}) + fin (${fin.toFixed(2)}) = 9903 (${w9903.toFixed(2)})`,
    });
  }

  return {
    years,
    balans: { activa, passiva },
    resultatenrekening: rr,
    resultaatverwerking: verwerking,
    checks,
  };
}
