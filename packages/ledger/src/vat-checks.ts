/**
 * Intervat "warnings requiring justification" — run BEFORE submitting.
 *
 * Intervat rejects a periodic VAT return that trips one of these rules unless the
 * XML carries a matching <Justification Code="..."> block. Running the same rules
 * locally turns "rejected, go figure out why" into "grid 55 looks off, here is the
 * rule, write one line".
 *
 * Rules transcribed from the FPS Finance Intervat API technical documentation
 * v14/07/2026, Annex 1 (VAT return / curator / objection). Converted in
 * docs/integrations/minfin/intervat-api-v2026.md (spark-workspace).
 *
 * VERIFY-LIVE: FPS revises this annex. Rule 5's threshold was corrected in the
 * 14.07.2026 revision (a typo had said 300000 where the implementation always used
 * 3.000,00). Re-check the annex when a new documentation version lands.
 */

export type VatWarning = {
  /** The exact Justification Code Intervat expects in the XML. */
  code: string;
  /** What the taxpayer sees in Intervat, in plain English. */
  message: string;
  /** The rule as documented, so the operator can check our arithmetic. */
  rule: string;
};

type Grids = Record<string, string | number>;

const g = (grids: Grids, box: string): number => {
  const raw = grids[box];
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = typeof raw === "number" ? raw : Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
};
const has = (grids: Grids, box: string): boolean => {
  const raw = grids[box];
  return raw !== undefined && raw !== null && raw !== "";
};

/**
 * Returns the warnings this return would trigger. Empty array = nothing to justify.
 * Amounts are compared in EUR with a cent-level epsilon, matching the documented
 * ">" comparisons rather than ">=".
 */
export function checkVatProbabilityRules(grids: Grids): VatWarning[] {
  const out: VatWarning[] = [];
  const EPS = 0.005;
  const gt = (a: number, b: number) => a - b > EPS;

  // 1. VAT due in 54 vs the rates applied to 01/02/03.
  if (has(grids, "54")) {
    const expected =
      g(grids, "01") * 0.06 + g(grids, "02") * 0.12 + g(grids, "03") * 0.21;
    if (gt(expected - g(grids, "54"), 62)) {
      out.push({
        code: "W_TVA_GRID_54O_INCORRECT_VALUE",
        message:
          "The VAT in grid 54 does not match the rates applied to grids 01, 02 and 03.",
        rule: "[(01x0,06)+(02x0,12)+(03x0,21)] - 54 > 62,00",
      });
    }
  }

  // 2. An amount in 87 but no VAT declared in 56/57.
  if (gt(g(grids, "87"), 250) && g(grids, "56") === 0 && g(grids, "57") === 0) {
    out.push({
      code: "W_TVA_GRID_5657_INCORRECT_VALUE",
      message:
        "You entered an amount in grid 87 but no VAT in grids 56 or 57. Fill in at least one.",
      rule: "87 > 250,00 AND 56 = 0 AND 57 = 0",
    });
  }

  // 3. 56+57 too high relative to 85+87.
  if (
    gt(
      g(grids, "56") +
        g(grids, "57") -
        (g(grids, "85") + g(grids, "87")) * 0.21,
      150,
    )
  ) {
    out.push({
      code: "W_TVA_GRID_5657_INCORRECT_VALUE_2",
      message:
        "The VAT in grids 56 and/or 57 exceeds 21% of the amounts in grids 85 and 87.",
      rule: "(56+57) - [(85+87)x0,21] > 150,00",
    });
  }

  // 4. Amounts in 86/88 but grid 55 left empty.
  if (
    !has(grids, "55") &&
    (g(grids, "86") > 0 || g(grids, "88") > 0) &&
    gt(g(grids, "86") + g(grids, "88"), 250)
  ) {
    out.push({
      code: "W_TVA_GRID_55_INCORRECT_VALUE",
      message:
        "You entered an amount in grids 86 and/or 88. In principle the VAT due belongs in grid 55.",
      rule: "55 IS NULL AND (86>0 OR 88>0) AND (86+88) > 250,00",
    });
  }

  // 5. Deduction in 59 too high relative to the purchase base 81..85.
  const base59 =
    g(grids, "81") +
    g(grids, "82") +
    g(grids, "83") +
    g(grids, "84") +
    g(grids, "85");
  const test59 = g(grids, "59") - base59 * 0.21;
  if (
    test59 >= 100000 ||
    (test59 >= 3000 && base59 > 0 && test59 / base59 >= 0.05)
  ) {
    out.push({
      code: "W_TVA_GRID_59_INCORRECT_VALUE",
      message:
        "The deduction in grid 59 is higher than 21% of the total of grids 81 to 85.",
      rule: "TEST = 59 - ((81..85)x0,21); TEST >= 100.000,00 OR (TEST >= 3.000,00 AND TEST/BASE >= 0,05)",
    });
  }

  // 6. Grid 64 vs grid 49.
  if (has(grids, "64") && gt(g(grids, "64") - g(grids, "49") * 0.21, 62)) {
    out.push({
      code: "W_TVA_GRID_64_INCORRECT_VALUE",
      message:
        "The amount in grid 64 is higher than 21% of the amount in grid 49.",
      rule: "64 - (49x0,21) > 62,00",
    });
  }

  // 7. Grid 55 too low against the 6% floor on 86+88.
  if (gt((g(grids, "86") + g(grids, "88")) * 0.06 - g(grids, "55"), 150)) {
    out.push({
      code: "W_TVA_GRID_55_INCORRECT_VALUE_3",
      message:
        "The amount in grid 55 is lower than 6% of the total of grids 86 and 88.",
      rule: "[(86+88)x0,06] - 55 > 150,00",
    });
  }

  // 8. 56+57 too low against the 6% floor on 87.
  if (gt(g(grids, "87") * 0.06 - (g(grids, "56") + g(grids, "57")), 150)) {
    out.push({
      code: "W_TVA_GRID_5657_INCORRECT_VALUE_3",
      message:
        "The VAT in grids 56 and/or 57 is lower than 6% of the amount in grid 87.",
      rule: "(87x0,06) - (56+57) > 150,00",
    });
  }

  // 9. Grid 55 too high against 84+86+88.
  if (
    gt(
      g(grids, "55") -
        (g(grids, "84") + g(grids, "86") + g(grids, "88")) * 0.21,
      150,
    )
  ) {
    out.push({
      code: "W_TVA_GRID_55_INCORRECT_VALUE_2",
      message:
        "The VAT in grid 55 is higher than 21% of the total of grids 84, 86 and 88.",
      rule: "55 - [(84+86+88)x0,21] > 150,00",
    });
  }

  return out;
}

/**
 * Build the <Justification> blocks for the warnings the operator has explained.
 * Intervat accepts the return when every triggered warning carries a comment.
 */
export function buildJustifications(
  explained: Array<{ code: string; comment: string }>,
): string {
  return explained
    .filter((e) => e.comment.trim().length > 0)
    .map(
      (e) =>
        `    <ns2:Justification Code="${e.code}">\n` +
        `      <Comment>${escapeXml(e.comment.trim())}</Comment>\n` +
        "    </ns2:Justification>",
    )
    .join("\n");
}

function escapeXml(s: string): string {
  return (
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      // '--' inside an XML comment is fatal to their parser; harmless to strip here too.
      .replace(/--/g, "-")
  );
}
