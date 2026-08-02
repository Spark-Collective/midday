/**
 * Onkostennota PDF (M10). Deliberately plain: this document exists to be read
 * by an accountant or a tax inspector, not to be pretty. It follows the layout
 * Spark already files, with one addition that matters under audit: every line
 * prints how its amount was computed (quantity x tariff x claimed share) and
 * where the tariff came from.
 */
import { Document, Page, Text, View } from "@react-pdf/renderer";

export type ExpenseNotePdfLine = {
  description: string;
  periodLabel?: string | null;
  category?: string | null;
  quantity?: number | null;
  unit?: string | null;
  unitPrice?: number | null;
  claimPct?: number | null;
  amount: number;
  basisNote?: string | null;
};

export type ExpenseNotePdfData = {
  noteNumber: string;
  issueDate: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  currency: string;
  total: number;
  notes?: string | null;
  submitter: { name: string; address?: string | null; iban?: string | null };
  company: {
    name: string;
    address?: string | null;
    vatNumber?: string | null;
    iban?: string | null;
    bic?: string | null;
  };
  lines: ExpenseNotePdfLine[];
};

const nf = (currency: string) =>
  new Intl.NumberFormat("nl-BE", { style: "currency", currency });

const date = (iso?: string | null) =>
  iso ? iso.split("-").reverse().join("/") : "";

/** "342 kWh x 0,2872 EUR/kWh x 100% (aandeel beroepsgebruik)" */
function calcDetail(l: ExpenseNotePdfLine, currency: string): string {
  const num = new Intl.NumberFormat("nl-BE", { maximumFractionDigits: 4 });
  const parts: string[] = [];
  if (l.quantity != null && l.unitPrice != null) {
    parts.push(
      `${num.format(l.quantity)}${l.unit ? ` ${l.unit}` : ""} x ${num.format(l.unitPrice)} ${currency}${l.unit ? `/${l.unit}` : ""}`,
    );
  } else {
    parts.push(`${nf(currency).format(l.amount / ((l.claimPct ?? 100) / 100))} (bedrag)`);
  }
  parts.push(`${num.format(l.claimPct ?? 100)}% (aandeel beroepsgebruik)`);
  return parts.join(" x ");
}

const s = {
  page: { padding: 40, fontSize: 9, fontFamily: "Helvetica" as const },
  h1: { fontSize: 18, marginBottom: 18 },
  row: { flexDirection: "row" as const },
  headRow: {
    flexDirection: "row" as const,
    borderBottomWidth: 1,
    borderBottomColor: "#000",
    paddingBottom: 4,
    marginBottom: 4,
    fontSize: 8,
  },
  line: {
    flexDirection: "row" as const,
    borderBottomWidth: 0.5,
    borderBottomColor: "#ddd",
    paddingVertical: 5,
  },
  muted: { color: "#666" },
  section: { marginTop: 22 },
  small: { fontSize: 7.5, color: "#666" },
};

export function ExpenseNotePdf({ data }: { data: ExpenseNotePdfData }) {
  const money = nf(data.currency);
  const byCategory = new Map<string, number>();
  for (const l of data.lines) {
    const key = l.category || "Overige";
    byCategory.set(key, (byCategory.get(key) ?? 0) + l.amount);
  }

  return (
    <Document>
      <Page size="A4" style={s.page}>
        <Text style={s.h1}>Onkostennota</Text>

        <View style={[s.row, { justifyContent: "space-between" }]}>
          <View style={{ width: "50%" }}>
            <Text>{data.submitter.name}</Text>
            {data.submitter.address ? (
              <Text style={s.muted}>{data.submitter.address}</Text>
            ) : null}
            {data.submitter.iban ? <Text>{data.submitter.iban}</Text> : null}
          </View>
          <View style={{ width: "45%" }}>
            <View style={[s.row, { justifyContent: "space-between" }]}>
              <Text style={s.muted}>Opmaakdatum</Text>
              <Text>{date(data.issueDate)}</Text>
            </View>
            {data.periodStart ? (
              <View style={[s.row, { justifyContent: "space-between" }]}>
                <Text style={s.muted}>Start periode</Text>
                <Text>{date(data.periodStart)}</Text>
              </View>
            ) : null}
            {data.periodEnd ? (
              <View style={[s.row, { justifyContent: "space-between" }]}>
                <Text style={s.muted}>Einde periode</Text>
                <Text>{date(data.periodEnd)}</Text>
              </View>
            ) : null}
            <View style={[s.row, { justifyContent: "space-between" }]}>
              <Text style={s.muted}>Nummer</Text>
              <Text>{data.noteNumber}</Text>
            </View>
          </View>
        </View>

        <View style={[s.section]}>
          <View style={s.headRow}>
            <Text style={{ width: "6%" }}>Nr.</Text>
            <Text style={{ width: "16%" }}>Periode</Text>
            <Text style={{ width: "40%" }}>Omschrijving</Text>
            <Text style={{ width: "20%" }}>Categorie</Text>
            <Text style={{ width: "18%", textAlign: "right" }}>Bedrag</Text>
          </View>
          {data.lines.map((l, i) => (
            <View style={s.line} key={`${l.description}-${i}`}>
              <Text style={{ width: "6%" }}>{i + 1}</Text>
              <Text style={{ width: "16%" }}>{l.periodLabel ?? ""}</Text>
              <Text style={{ width: "40%" }}>{l.description}</Text>
              <Text style={{ width: "20%" }}>{l.category ?? ""}</Text>
              <Text style={{ width: "18%", textAlign: "right" }}>
                {money.format(l.amount)}
              </Text>
            </View>
          ))}
          <View style={[s.row, { paddingTop: 8, justifyContent: "flex-end" }]}>
            <Text style={{ width: "20%", textAlign: "right" }}>Totaal</Text>
            <Text
              style={{ width: "18%", textAlign: "right", fontFamily: "Helvetica-Bold" }}
            >
              {money.format(data.total)}
            </Text>
          </View>
        </View>

        <View style={s.section}>
          <View style={s.headRow}>
            <Text style={{ width: "82%" }}>Categorie</Text>
            <Text style={{ width: "18%", textAlign: "right" }}>Bedrag</Text>
          </View>
          {[...byCategory.entries()].map(([cat, amount]) => (
            <View style={s.line} key={cat}>
              <Text style={{ width: "82%" }}>{cat}</Text>
              <Text style={{ width: "18%", textAlign: "right" }}>
                {money.format(amount)}
              </Text>
            </View>
          ))}
        </View>

        <View style={s.section}>
          <Text style={{ marginBottom: 6 }}>Details berekeningen</Text>
          <View style={s.headRow}>
            <Text style={{ width: "6%" }}>Nr.</Text>
            <Text style={{ width: "56%" }}>Details</Text>
            <Text style={{ width: "20%" }}>Categorie</Text>
            <Text style={{ width: "18%", textAlign: "right" }}>Bedrag</Text>
          </View>
          {data.lines.map((l, i) => (
            <View style={s.line} key={`calc-${l.description}-${i}`}>
              <Text style={{ width: "6%" }}>{i + 1}</Text>
              <View style={{ width: "56%" }}>
                <Text>{calcDetail(l, data.currency)}</Text>
                {l.basisNote ? (
                  <Text style={s.small}>{l.basisNote}</Text>
                ) : null}
              </View>
              <Text style={{ width: "20%" }}>{l.category ?? ""}</Text>
              <Text style={{ width: "18%", textAlign: "right" }}>
                {money.format(l.amount)}
              </Text>
            </View>
          ))}
        </View>

        {data.notes ? (
          <View style={s.section}>
            <Text style={{ marginBottom: 4 }}>Notities</Text>
            <Text style={s.muted}>{data.notes}</Text>
          </View>
        ) : null}

        <View style={{ marginTop: 30 }}>
          <Text style={s.small}>
            De indiener van deze onkostennota verbindt zich ertoe de bijbehorende
            bewijsstukken ter beschikking te houden voor fiscale controle.
          </Text>
        </View>

        <View style={{ marginTop: 18, alignItems: "center" }}>
          <Text style={s.small}>{data.company.name}</Text>
          {data.company.address ? (
            <Text style={s.small}>{data.company.address}</Text>
          ) : null}
          <Text style={s.small}>
            {[data.company.vatNumber, data.company.iban, data.company.bic]
              .filter(Boolean)
              .join("  ")}
          </Text>
        </View>
      </Page>
    </Document>
  );
}
