/**
 * Annual accounts (M9): map ledger balances to the NBB micro-model
 * rubrieken (m87-f, vennootschap zonder kapitaal). Pure PCMN-prefix
 * bucketing like the statement engine; both the balance sheet (cumulative)
 * and the micro income statement (period-bounded, brutomarge form) with the
 * arithmetic controls the Balanscentrale enforces. The XBRL serialization
 * lives in annual-accounts-xbrl.ts; filing itself stays a human act.
 */
import { checkLegalControls } from "./annual-accounts-xbrl.js";
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
  /** Balanscentrale legal controls; all must be true to file. */
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  /** rubriek -> values per period, the XBRL writer's input. */
  values: Record<string, number[]>;
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
      r2(
        pick(b, ["21"]) +
          pick(b, ["22", "23", "24", "25", "26", "27"]) +
          pick(b, ["28"]),
      ),
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
    rub("490/1", "Overlopende rekeningen (actief)", (b) =>
      pick(b, ["490", "491"]),
    ),
    rub("29/58", "Vlottende activa", (b) =>
      r2(
        pick(b, [
          "29",
          "3",
          "40",
          "41",
          "50",
          "51",
          "52",
          "53",
          "54",
          "55",
          "56",
          "57",
          "58",
          "490",
          "491",
        ]),
      ),
    ),
    rub("20/58", "TOTAAL ACTIVA", (b) =>
      r2(
        pick(b, ["20", "21", "22", "23", "24", "25", "26", "27", "28"]) +
          pick(b, [
            "29",
            "3",
            "40",
            "41",
            "50",
            "51",
            "52",
            "53",
            "54",
            "55",
            "56",
            "57",
            "58",
            "490",
            "491",
          ]),
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
        pick(b, [
          "29",
          "3",
          "40",
          "41",
          "50",
          "51",
          "52",
          "53",
          "54",
          "55",
          "56",
          "57",
          "58",
          "490",
          "491",
        ]),
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
    rub("16", "Voorzieningen en uitgestelde belastingen", (b) =>
      pick(b, ["16"], -1),
    ),
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
    rub("10/49", "TOTAAL PASSIVA", (b) =>
      r2(passivaBooked(b) + unallocated(b)),
    ),
  ];

  // ---------------- Resultatenrekening (micro: brutomarge form)
  // The niet-recurrente accounts split between the operating and financial
  // blocks: 660-663 / 760-762 are operating (66A / 76A), 664-669 / 763-769
  // financial (66B / 76B). The rubrieken below are the definition; the legal
  // controls in annual-accounts-xbrl.ts verify them.
  const NR_COST_OP = ["660", "661", "662", "663"];
  const NR_COST_FIN = ["664", "665", "666", "667", "668", "669"];
  const NR_INC_OP = ["760", "761", "762"];
  const NR_INC_FIN = ["763", "764", "765", "766", "767", "768", "769"];
  const nrCostOp = (p: Sums) => pick(p, NR_COST_OP);
  const nrIncOp = (p: Sums) => pick(p, NR_INC_OP, -1);
  /** 9900 = bedrijfsopbrengsten (70/74 + 76A) - 60 - 61 */
  const brutomarge = (p: Sums) =>
    r2(
      pick(p, ["70", "71", "72", "74"], -1) +
        nrIncOp(p) -
        pick(p, ["60"]) -
        pick(p, ["61"]),
    );
  const finOpbrengsten = (p: Sums) =>
    r2(pick(p, ["75"], -1) + pick(p, NR_INC_FIN, -1));
  const finKosten = (p: Sums) => r2(pick(p, ["65"]) + pick(p, NR_COST_FIN));
  /** 649 is credit-natural and displayed non-positive. */
  const geactiveerd = (p: Sums) => pick(p, ["649"]);
  const bedrijfswinst = (p: Sums) =>
    r2(
      brutomarge(p) -
        pick(p, ["62"]) -
        pick(p, ["630"]) -
        pick(p, ["631", "632", "633", "634"]) -
        pick(p, ["635", "636", "637", "638"]) -
        pick(p, [
          "640",
          "641",
          "642",
          "643",
          "644",
          "645",
          "646",
          "647",
          "648",
        ]) -
        geactiveerd(p) -
        nrCostOp(p),
    );
  const winstVoorBelasting = (p: Sums) =>
    r2(bedrijfswinst(p) + finOpbrengsten(p) - finKosten(p));
  /** 67/77 net tax charge; 780/680 deferred-tax movements. */
  const belastingen = (p: Sums) => r2(pick(p, ["67"]) - pick(p, ["77"], -1));
  const winstBoekjaar = (p: Sums) =>
    r2(
      winstVoorBelasting(p) +
        pick(p, ["780"], -1) -
        pick(p, ["680"]) -
        belastingen(p),
    );
  /** 9905 te bestemmen winst VAN HET BOEKJAAR (before adding 14P). */
  const teBestemmenBoekjaar = (p: Sums) =>
    r2(winstBoekjaar(p) + pick(p, ["789"], -1) - pick(p, ["689"]));

  const rr: Rubriek[] = [
    rub("9900", "Brutomarge", (_b, p) => brutomarge(p)),
    rub("62", "Bezoldigingen, sociale lasten en pensioenen", (_b, p) =>
      pick(p, ["62"]),
    ),
    rub(
      "630",
      "Afschrijvingen en waardeverminderingen op vaste activa",
      (_b, p) => pick(p, ["630"]),
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
    rub(
      "649",
      "Als herstructureringskosten geactiveerde bedrijfskosten (-)",
      (_b, p) => geactiveerd(p),
    ),
    rub("66A", "Niet-recurrente bedrijfskosten", (_b, p) => nrCostOp(p)),
    rub("76A", "Niet-recurrente bedrijfsopbrengsten", (_b, p) => nrIncOp(p)),
    rub("9901", "Bedrijfswinst (Bedrijfsverlies)", (_b, p) => bedrijfswinst(p)),
    rub("75/76B", "Financiële opbrengsten", (_b, p) => finOpbrengsten(p)),
    rub("753", "Waarvan: kapitaal- en interestsubsidies", (_b, p) =>
      pick(p, ["753"], -1),
    ),
    rub("65/66B", "Financiële kosten", (_b, p) => finKosten(p)),
    rub("9903", "Winst (Verlies) van het boekjaar vóór belasting", (_b, p) =>
      winstVoorBelasting(p),
    ),
    rub("780", "Onttrekking aan de uitgestelde belastingen", (_b, p) =>
      pick(p, ["780"], -1),
    ),
    rub("680", "Overboeking naar de uitgestelde belastingen", (_b, p) =>
      pick(p, ["680"]),
    ),
    rub("67/77", "Belastingen op het resultaat", (_b, p) => belastingen(p)),
    rub("9904", "Winst (Verlies) van het boekjaar", (_b, p) =>
      winstBoekjaar(p),
    ),
    rub("789", "Onttrekking aan de belastingvrije reserves", (_b, p) =>
      pick(p, ["789"], -1),
    ),
    rub("689", "Overboeking naar de belastingvrije reserves", (_b, p) =>
      pick(p, ["689"]),
    ),
    rub("9905", "Te bestemmen winst (verlies) van het boekjaar", (_b, p) =>
      teBestemmenBoekjaar(p),
    ),
  ];

  // ---------------- Resultaatverwerking (section 5)
  // 9906 = 9905 + 14P; 14 = 9906 + 791/2 - 691/2 + 794 - 694/7. 14P is the
  // result carried in from last year (790 when the year has been processed,
  // otherwise the opening balance of 14).
  const overgedragenVorig = (b: Sums, p: Sums) => {
    const viaBooking = pick(p, ["790"], -1);
    if (viaBooking !== 0) return viaBooking;
    // not processed yet: 14 at the start of the year = closing 14 minus what
    // this year's own processing added (nothing), i.e. the 14 balance itself.
    return r2(pick(b, ["14"], -1) - pick(p, ["14"], -1));
  };
  const verwerking: Rubriek[] = [
    rub("14P", "Overgedragen winst (verlies) van het vorige boekjaar", (b, p) =>
      overgedragenVorig(b, p),
    ),
    rub("9906", "Te bestemmen winst (verlies)", (b, p) =>
      r2(teBestemmenBoekjaar(p) + overgedragenVorig(b, p)),
    ),
    rub("791/2", "Onttrekking aan het eigen vermogen", (_b, p) =>
      pick(p, ["791", "792"], -1),
    ),
    rub("691/2", "Toevoeging aan het eigen vermogen", (_b, p) =>
      pick(p, ["691", "692"]),
    ),
    rub("794", "Tussenkomst van de vennoten in het verlies", (_b, p) =>
      pick(p, ["794"], -1),
    ),
    rub("694/7", "Uit te keren winst", (_b, p) =>
      pick(p, ["694", "695", "696", "697"]),
    ),
    rub("14", "Over te dragen winst (verlies)", (b, p) =>
      r2(
        teBestemmenBoekjaar(p) +
          overgedragenVorig(b, p) +
          pick(p, ["791", "792"], -1) -
          pick(p, ["691", "692"]) +
          pick(p, ["794"], -1) -
          pick(p, ["694", "695", "696", "697"]),
      ),
    ),
  ];

  // ---------------- Controls: the Balanscentrale legal controls (App. 2.1),
  // run per period column. A filing failing one of these is refused (DAT 33).
  const flat: Record<string, number[]> = {};
  for (const list of [activa, passiva, rr, verwerking]) {
    for (const r of list) flat[r.code] = r.values;
  }
  const checks: AnnualAccounts["checks"] = [];
  years.forEach((y, i) => {
    for (const c of checkLegalControls(flat, i)) {
      checks.push({ name: `${c.control} (${y})`, ok: c.ok, detail: c.detail });
    }
  });

  return {
    years,
    balans: { activa, passiva },
    resultatenrekening: rr,
    resultaatverwerking: verwerking,
    checks,
    /** rubriek -> values, ready for the XBRL writer. */
    values: flat,
  };
}
