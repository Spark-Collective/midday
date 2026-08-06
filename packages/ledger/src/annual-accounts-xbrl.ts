/**
 * CBSO XBRL instance writer (M9): serialize the micro-model rubrieken into a
 * filing-ready XBRL 2.1 instance for filing.cbso.nbb.be.
 *
 * The CBSO taxonomy is DPM-style: there is no element per rubriek. A fact is a
 * generic metric (met:am1 non-negative, met:am2 signed, met:am3 non-positive)
 * qualified by dimension members, and the rubriek code lives only as a
 * table-linkbase label. The rubriek -> datapoint map in cbso-m87f-map.json is
 * therefore EXTRACTED from the official taxonomy by
 * scripts/extract-cbso-map.py, never hand-written — re-run it when the NBB
 * publishes a new taxonomy and diff the JSON.
 *
 * This writes the file; the deposit itself stays a human act (CSAM/itsme).
 *
 * STATUS (2026-08-02): validated with Arelle 2.37 against NBB-CBSO-26.0.15.
 * 92 of 104 facts are accepted. Two gaps remain before a real deposit:
 *   1. Section 1 (identificatie) is not emitted yet - the CBSO requires
 *      entity name, legal form, address, court, deposit date of the last
 *      deed, and the accounting period start/end dates (oa_01.00.* rules).
 *   2. Six equity/total rubrieken (10/11, 12, 13, 14, 15, 10/49) still get a
 *      dimension tuple the taxonomy rejects: their rows inherit members
 *      through a presentation path the extractor does not follow yet.
 * The rubriek VALUES are correct and reproduce the filed 2025 accounts; it is
 * the XBRL envelope that is unfinished. Always run Arelle over the generated
 * instance (or the Filing app's validate step) before depositing.
 */
import MAP from "./cbso-m87f-map.json" with { type: "json" };

type Datapoint = {
  concept: string;
  dims: Record<string, string>;
  part: string;
  label: string;
};

const RUBRIEKEN = MAP.rubrieken as unknown as Record<string, Datapoint>;

export type XbrlDeclarant = {
  /** 10-digit KBO/CBE number, digits only. */
  enterpriseNumber: string;
  name: string;
};

export type XbrlInput = {
  declarant: XbrlDeclarant;
  /** Closing date of the reported financial year, YYYY-MM-DD. */
  closingDate: string;
  /** Closing date of the comparative year, YYYY-MM-DD (optional). */
  previousClosingDate?: string;
  /** rubriek code -> [current, previous?] amounts in EUR. */
  values: Record<string, number[]>;
};

/** Prefixes used in the instance; the DTS resolves them via the entry point. */
const NAMESPACES: Record<string, string> = {
  xmlns: "http://www.xbrl.org/2003/instance",
  "xmlns:link": "http://www.xbrl.org/2003/linkbase",
  "xmlns:xlink": "http://www.w3.org/1999/xlink",
  "xmlns:xbrldi": "http://xbrl.org/2006/xbrldi",
  "xmlns:iso4217": "http://www.xbrl.org/2003/iso4217",
  "xmlns:met": "http://www.nbb.be/be/fr/cbso/dict/met",
  "xmlns:dim": "http://www.nbb.be/be/fr/cbso/dict/dim",
  "xmlns:prd": "http://www.nbb.be/be/fr/cbso/dict/dom/prd",
  "xmlns:part": "http://www.nbb.be/be/fr/cbso/dict/dom/part",
};

/** Domain prefixes appearing in the extracted map (bas, ntr, typ, ...). */
function domainPrefixes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dp of Object.values(RUBRIEKEN)) {
    for (const member of Object.values(dp.dims)) {
      const prefix = member.split(":")[0]!;
      out[`xmlns:${prefix}`] =
        `http://www.nbb.be/be/fr/cbso/dict/dom/${prefix}`;
    }
  }
  return out;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** met:am1 is non-negative and met:am3 non-positive; the model expects the
 *  rubriek's natural sign, so flip a signed value onto the metric's domain. */
function forConcept(concept: string, value: number): number {
  if (concept === "met:am1") return Math.abs(value);
  if (concept === "met:am3") return -Math.abs(value);
  return value;
}

export type XbrlResult = {
  xml: string;
  filename: string;
  /** rubrieken that carry a value but are unknown to the taxonomy map. */
  skipped: string[];
  factCount: number;
};

export function buildAnnualAccountsXbrl(input: XbrlInput): XbrlResult {
  const periods: Array<{ date: string; member: string }> = [
    { date: input.closingDate, member: "prd:m1" },
  ];
  if (input.previousClosingDate) {
    periods.push({ date: input.previousClosingDate, member: "prd:m2" });
  }

  const contexts: string[] = [];
  const facts: string[] = [];
  const skipped: string[] = [];
  const seen = new Map<string, string>(); // context signature -> id
  let ctxSeq = 0;

  for (const [code, amounts] of Object.entries(input.values)) {
    const dp = RUBRIEKEN[code];
    if (!dp) {
      skipped.push(code);
      continue;
    }
    periods.forEach((period, i) => {
      const value = amounts[i];
      if (value === undefined || value === null) return;
      const members: Array<[string, string]> = [
        ["dim:prd", period.member],
        ["dim:part", dp.part],
        ...Object.entries(dp.dims).sort(([a], [b]) => a.localeCompare(b)),
      ];
      const signature = `${period.date}|${members.map((m) => m.join("=")).join(",")}`;
      let ctxId = seen.get(signature);
      if (!ctxId) {
        ctxId = `c${++ctxSeq}`;
        seen.set(signature, ctxId);
        contexts.push(
          [
            `  <context id="${ctxId}">`,
            "    <entity>",
            `      <identifier scheme="http://www.fgov.be">${esc(input.declarant.enterpriseNumber)}</identifier>`,
            "    </entity>",
            `    <period><instant>${period.date}</instant></period>`,
            "    <scenario>",
            ...members.map(
              ([dim, member]) =>
                `      <xbrldi:explicitMember dimension="${dim}">${member}</xbrldi:explicitMember>`,
            ),
            "    </scenario>",
            "  </context>",
          ].join("\n"),
        );
      }
      const amount = forConcept(dp.concept, value).toFixed(2);
      facts.push(
        `  <${dp.concept} contextRef="${ctxId}" decimals="INF" unitRef="EUR">${amount}</${dp.concept}>` +
          `<!-- ${code} ${esc(dp.label)} -->`,
      );
    });
  }

  const ns = { ...NAMESPACES, ...domainPrefixes() };
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<xbrl ${Object.entries(ns)
      .map(([k, v]) => `${k}="${v}"`)
      .join("\n      ")}>`,
    `  <link:schemaRef xlink:type="simple" xlink:href="${MAP.entryPoint}"/>`,
    ...contexts,
    '  <unit id="EUR"><measure>iso4217:EUR</measure></unit>',
    ...facts,
    "</xbrl>",
    "",
  ].join("\n");

  const year = input.closingDate.slice(0, 4);
  return {
    xml,
    filename: `${input.declarant.enterpriseNumber}-${year}-${MAP.model}.xbrl`,
    skipped,
    factCount: facts.length,
  };
}

/**
 * The legal arithmetic controls the Balanscentrale enforces for the micro
 * schema without capital (technical guide appendix 2.1). A filing that fails
 * one of these is refused with code DAT 33, so we check before writing.
 * Each entry: target rubriek = sum of [rubriek, sign] terms.
 */
export const LEGAL_CONTROLS: Array<[string, Array<[string, 1 | -1]>]> = [
  [
    "21/28",
    [
      ["21", 1],
      ["22/27", 1],
      ["28", 1],
    ],
  ],
  [
    "29/58",
    [
      ["29", 1],
      ["3", 1],
      ["40/41", 1],
      ["50/53", 1],
      ["54/58", 1],
      ["490/1", 1],
    ],
  ],
  [
    "20/58",
    [
      ["20", 1],
      ["21/28", 1],
      ["29/58", 1],
    ],
  ],
  [
    "10/15",
    [
      ["10/11", 1],
      ["12", 1],
      ["13", 1],
      ["14", 1],
      ["15", 1],
      ["19", -1],
    ],
  ],
  [
    "17/49",
    [
      ["17", 1],
      ["42/48", 1],
      ["492/3", 1],
    ],
  ],
  [
    "10/49",
    [
      ["10/15", 1],
      ["16", 1],
      ["17/49", 1],
    ],
  ],
  [
    "20/58=10/49",
    [
      ["20/58", 1],
      ["10/49", -1],
    ],
  ],
  [
    "9901",
    [
      ["9900", 1],
      ["62", -1],
      ["630", -1],
      ["631/4", -1],
      ["635/8", -1],
      ["640/8", -1],
      ["649", -1],
      ["66A", -1],
    ],
  ],
  [
    "9903",
    [
      ["9901", 1],
      ["75/76B", 1],
      ["65/66B", -1],
    ],
  ],
  [
    "9904",
    [
      ["9903", 1],
      ["780", 1],
      ["680", -1],
      ["67/77", -1],
    ],
  ],
  [
    "9905",
    [
      ["9904", 1],
      ["789", 1],
      ["689", -1],
    ],
  ],
  [
    "9906",
    [
      ["9905", 1],
      ["14P", 1],
    ],
  ],
  [
    "14",
    [
      ["9906", 1],
      ["791/2", 1],
      ["691/2", -1],
      ["794", 1],
      ["694/7", -1],
    ],
  ],
];

export type ControlResult = { control: string; ok: boolean; detail: string };

/** Run the legal controls over one period column (index 0 = current year). */
export function checkLegalControls(
  values: Record<string, number[]>,
  period = 0,
): ControlResult[] {
  const v = (code: string) => values[code]?.[period] ?? 0;
  return LEGAL_CONTROLS.map(([target, terms]) => {
    const sum = terms.reduce((acc, [code, sign]) => acc + sign * v(code), 0);
    // "a=b" style controls state the difference is zero; the others compare
    // the computed sum against the reported target rubriek.
    const isIdentity = target.includes("=");
    const expected = isIdentity ? 0 : v(target);
    const ok = Math.abs(sum - expected) < 0.005;
    return {
      control: isIdentity
        ? target
        : `${target} = ${terms.map(([c, s]) => `${s < 0 ? "-" : "+"}${c}`).join(" ")}`,
      ok,
      detail: ok
        ? "ok"
        : `computed ${sum.toFixed(2)} vs reported ${expected.toFixed(2)}`,
    };
  });
}
