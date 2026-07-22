"use client";

import { Button } from "@midday/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@midday/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@midday/ui/tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const YEARS = (() => {
  const now = new Date().getFullYear();
  const list = [];
  for (let y = now; y >= 2023; y--) list.push(y);
  return list;
})();

const eur = new Intl.NumberFormat("nl-BE", {
  style: "currency",
  currency: "EUR",
});
const eur0 = new Intl.NumberFormat("nl-BE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

function Amount({ value }: { value: number }) {
  return (
    <span className="font-mono tabular-nums">
      {value === 0 ? "—" : eur.format(value)}
    </span>
  );
}

type GlPreset = { accountCode?: string; from?: string; to?: string };

function YearSelect({
  value,
  onChange,
  allowNone,
}: {
  value: number | undefined;
  onChange: (y: number | undefined) => void;
  allowNone?: boolean;
}) {
  return (
    <select
      className="border bg-background px-2 py-1 text-sm"
      value={value ?? ""}
      onChange={(e) =>
        onChange(e.target.value === "" ? undefined : Number(e.target.value))
      }
    >
      {allowNone && <option value="">—</option>}
      {YEARS.map((y) => (
        <option key={y} value={y}>
          {y}
        </option>
      ))}
    </select>
  );
}

function OverviewTab() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.ledger.overview.queryOptions({ year }),
  );
  if (isLoading || !data)
    return <p className="text-sm text-muted-foreground">Loading…</p>;

  const maxGroup = Math.max(...data.costGroups.map((g) => g.amount), 1);
  const maxVat = Math.max(
    ...data.vatQuarters.flatMap((q) => [q.deductible, q.payable]),
    1,
  );
  const bankTotal = data.bank.reduce((s, b) => s + b.balance, 0);

  const kpi = (
    label: string,
    value: number,
    sub: string,
    negative?: boolean,
  ) => (
    <div className="border bg-muted/20 p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`mt-1 font-mono text-xl tabular-nums ${negative ? "text-destructive" : ""}`}
      >
        {eur0.format(value)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <YearSelect value={year} onChange={(y) => setYear(y ?? year)} />
        <span className="text-xs text-muted-foreground">
          through {data.asOf}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpi(
          `Revenue ${year} YTD`,
          data.revenueYtd,
          `vs ${eur0.format(data.revenuePrevYtd)} same period ${year - 1}`,
        )}
        {kpi(
          `Costs ${year} YTD`,
          data.costsYtd,
          `vs ${eur0.format(data.costsPrevYtd)} same period ${year - 1}`,
        )}
        {kpi(
          `Result ${year} YTD`,
          data.resultYtd,
          `vs ${eur0.format(data.resultPrevYtd)} same period ${year - 1}`,
          data.resultYtd < 0,
        )}
        {kpi(
          "Bank today",
          bankTotal,
          data.bank
            .map((b) => `${b.name} ${eur0.format(b.balance)}`)
            .join(" · "),
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="border p-4">
          <p className="mb-3 text-sm font-medium">
            Cost distribution {year}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              by PCMN group
            </span>
          </p>
          <div className="space-y-2">
            {data.costGroups.map((g) => (
              <div key={g.label} className="flex items-center gap-2 text-xs">
                <span className="w-40 shrink-0 truncate">{g.label}</span>
                <div className="h-3 flex-1 bg-muted/30">
                  <div
                    className="h-3 bg-primary"
                    style={{
                      width: `${Math.max((g.amount / maxGroup) * 100, 1)}%`,
                    }}
                  />
                </div>
                <span className="w-20 shrink-0 text-right font-mono tabular-nums">
                  {eur0.format(g.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="border p-4">
          <p className="mb-3 text-sm font-medium">
            VAT per quarter
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              deductible vs payable
            </span>
          </p>
          <div className="flex h-40 items-end gap-4">
            {data.vatQuarters.map((q) => (
              <div
                key={q.quarter}
                className="flex flex-1 flex-col items-center gap-1"
              >
                <div className="flex h-32 w-full items-end justify-center gap-1">
                  <div
                    className="w-1/3 bg-primary"
                    title={`Deductible ${eur.format(q.deductible)}`}
                    style={{ height: `${(q.deductible / maxVat) * 100}%` }}
                  />
                  <div
                    className="w-1/3 bg-muted-foreground/40"
                    title={`Payable ${eur.format(q.payable)}`}
                    style={{ height: `${(q.payable / maxVat) * 100}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground">
                  Q{q.quarter}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 bg-primary" /> deductible
              (411000)
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 bg-muted-foreground/40" />{" "}
              payable (451000)
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatementTab({
  kind,
  onDrill,
}: {
  kind: "income" | "balance";
  onDrill: (preset: GlPreset) => void;
}) {
  const now = new Date().getFullYear();
  const [year, setYear] = useState(now);
  const [compareYear, setCompareYear] = useState<number | undefined>(now - 1);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.ledger.statement.queryOptions({ kind, year, compareYear }),
  );
  if (isLoading || !data)
    return <p className="text-sm text-muted-foreground">Loading…</p>;

  const totals = new Map(data.sections.map((s) => [s.key, s.totals]));
  const col = (key: string, i: number) => totals.get(key)?.[i] ?? 0;
  const cols = data.periods.length;
  const idx = [...Array(cols).keys()];

  // Intermediate result rows for the income statement.
  const bedrijfsresultaat = idx.map(
    (i) => col("opbrengsten", i) - col("kosten", i),
  );
  const financieel = idx.map(
    (i) => col("fin_opbrengsten", i) - col("fin_kosten", i),
  );

  const drill = (code: string, i: number) => {
    const y = Number(data.periods[i]?.label ?? year);
    onDrill({
      accountCode: code,
      from: kind === "income" ? `${y}-01-01` : undefined,
      to: data.periods[i]?.to,
    });
  };

  const sectionRows = (sectionKey: string) => {
    const s = data.sections.find((x) => x.key === sectionKey);
    if (!s || s.rows.length === 0) return null;
    const isCollapsed = collapsed[s.key];
    return (
      <>
        <TableRow
          className="cursor-pointer select-none font-medium hover:bg-muted/30"
          onClick={() => setCollapsed((c) => ({ ...c, [s.key]: !c[s.key] }))}
        >
          <TableCell>
            <span className="mr-1 inline-block w-3 text-muted-foreground">
              {isCollapsed ? "▸" : "▾"}
            </span>
            {s.label}
          </TableCell>
          {s.totals.map((t, i) => (
            <TableCell key={i} className="text-right">
              <Amount value={t} />
            </TableCell>
          ))}
        </TableRow>
        {!isCollapsed &&
          s.rows.map((r) => (
            <TableRow
              key={r.code}
              className="cursor-pointer text-muted-foreground hover:bg-muted/30"
              onClick={() => r.code !== "—" && drill(r.code, 0)}
              title={r.code !== "—" ? "Open in general ledger" : undefined}
            >
              <TableCell className="pl-8">
                <span className="font-mono text-xs">{r.code}</span>
                <span className="ml-2 text-sm">{r.name}</span>
              </TableCell>
              {r.values.map((v, i) => (
                <TableCell key={i} className="text-right">
                  <Amount value={v} />
                </TableCell>
              ))}
            </TableRow>
          ))}
      </>
    );
  };

  const resultRow = (label: string, values: number[], strong?: boolean) => (
    <TableRow
      className={strong ? "border-t-2 font-medium" : "border-t font-medium"}
    >
      <TableCell>{label}</TableCell>
      {values.map((v, i) => (
        <TableCell
          key={i}
          className={`text-right ${v < 0 ? "text-destructive" : ""}`}
        >
          <Amount value={v} />
        </TableCell>
      ))}
    </TableRow>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <YearSelect value={year} onChange={(y) => setYear(y ?? year)} />
        <span className="text-muted-foreground">vs</span>
        <YearSelect value={compareYear} onChange={setCompareYear} allowNone />
      </div>
      <Table className="max-w-3xl">
        <TableHeader>
          <TableRow>
            <TableHead />
            {data.periods.map((p) => (
              <TableHead key={p.label} className="w-36 text-right">
                {p.label}
                {p.to.slice(5) !== "12-31" && (
                  <span className="ml-1 text-xs font-normal">YTD</span>
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {kind === "income" ? (
            <>
              {sectionRows("opbrengsten")}
              {sectionRows("kosten")}
              {resultRow("Bedrijfswinst / -verlies", bedrijfsresultaat)}
              {sectionRows("fin_opbrengsten")}
              {sectionRows("fin_kosten")}
              {resultRow("Financieel resultaat", financieel)}
              {sectionRows("uitzonderlijk")}
              {sectionRows("belastingen")}
              {sectionRows("verwerking")}
              {resultRow("Winst / verlies van het boekjaar", data.result, true)}
            </>
          ) : (
            <>
              {sectionRows("vaste_activa")}
              {sectionRows("vorderingen")}
              {sectionRows("liquide")}
              {resultRow(
                "Totaal activa",
                idx.map(
                  (i) =>
                    col("vaste_activa", i) +
                    col("vorderingen", i) +
                    col("liquide", i),
                ),
              )}
              {sectionRows("eigen_vermogen")}
              {sectionRows("schulden")}
              {resultRow(
                "Totaal passiva",
                idx.map((i) => col("eigen_vermogen", i) + col("schulden", i)),
                true,
              )}
            </>
          )}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        Click any account row to open it in the general ledger.
      </p>
    </div>
  );
}

function TrialBalanceTab() {
  const trpc = useTRPC();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { data, isLoading } = useQuery(
    trpc.ledger.trialBalance.queryOptions({
      from: from || undefined,
      to: to || undefined,
    }),
  );
  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  const totals = (data ?? []).reduce(
    (t, r) => ({ debit: t.debit + r.debit, credit: t.credit + r.credit }),
    { debit: 0, credit: 0 },
  );
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <input
          type="date"
          className="border bg-background px-2 py-1"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <span className="text-muted-foreground">to</span>
        <input
          type="date"
          className="border bg-background px-2 py-1"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      {!data?.length ? (
        <p className="text-sm text-muted-foreground">No posted entries.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">Account</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Debit</TableHead>
              <TableHead className="text-right">Credit</TableHead>
              <TableHead className="text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((r) => (
              <TableRow key={r.accountId}>
                <TableCell className="font-mono">{r.code}</TableCell>
                <TableCell>{r.name}</TableCell>
                <TableCell className="text-right">
                  <Amount value={r.debit} />
                </TableCell>
                <TableCell className="text-right">
                  <Amount value={r.credit} />
                </TableCell>
                <TableCell className="text-right">
                  <Amount value={r.balance} />
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="font-medium">
              <TableCell colSpan={2}>Total</TableCell>
              <TableCell className="text-right">
                <Amount value={totals.debit} />
              </TableCell>
              <TableCell className="text-right">
                <Amount value={totals.credit} />
              </TableCell>
              <TableCell className="text-right">
                <Amount value={totals.debit - totals.credit} />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function GeneralLedgerTab({ preset }: { preset: GlPreset | null }) {
  const trpc = useTRPC();
  const [accountCode, setAccountCode] = useState(preset?.accountCode ?? "");
  const [from, setFrom] = useState(preset?.from ?? "");
  const [to, setTo] = useState(preset?.to ?? "");
  const { data, isLoading } = useQuery(
    trpc.ledger.generalLedger.queryOptions({
      accountCode: accountCode || undefined,
      from: from || undefined,
      to: to || undefined,
      limit: 300,
    }),
  );
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <input
          placeholder="Account code"
          className="w-32 border bg-background px-2 py-1"
          value={accountCode}
          onChange={(e) => setAccountCode(e.target.value)}
        />
        <input
          type="date"
          className="border bg-background px-2 py-1"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <span className="text-muted-foreground">to</span>
        <input
          type="date"
          className="border bg-background px-2 py-1"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !data?.length ? (
        <p className="text-sm text-muted-foreground">No ledger lines.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">Date</TableHead>
              <TableHead className="w-28">Entry</TableHead>
              <TableHead className="w-24">Account</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Debit</TableHead>
              <TableHead className="text-right">Credit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((r, i) => (
              <TableRow key={`${r.entryId}-${r.accountCode}-${i}`}>
                <TableCell>{r.date}</TableCell>
                <TableCell className="font-mono">
                  {r.entryNumber ?? "—"}
                </TableCell>
                <TableCell className="font-mono" title={r.accountName}>
                  {r.accountCode}
                </TableCell>
                <TableCell className="max-w-96 truncate">
                  {r.description}
                </TableCell>
                <TableCell className="text-right">
                  <Amount value={r.debit} />
                </TableCell>
                <TableCell className="text-right">
                  <Amount value={r.credit} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function OpenItemsTab() {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(trpc.ledger.openItems.queryOptions({}));
  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!data?.length)
    return (
      <p className="text-sm text-muted-foreground">
        No open items — everything is reconciled.
      </p>
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-28">Date</TableHead>
          <TableHead className="w-24">Account</TableHead>
          <TableHead>Description</TableHead>
          <TableHead className="text-right">Open amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((r) => (
          <TableRow key={r.lineId}>
            <TableCell>{r.date}</TableCell>
            <TableCell className="font-mono">{r.accountCode}</TableCell>
            <TableCell className="max-w-96 truncate">{r.description}</TableCell>
            <TableCell className="text-right">
              <Amount value={r.residual} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PeriodsTab() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery(
    trpc.ledger.periods.queryOptions({ year }),
  );

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.ledger.periods.queryKey({ year }),
    });

  const closePeriodMutation = useMutation(
    trpc.ledger.closePeriod.mutationOptions({
      onSuccess: invalidate,
      onError: (error, variables) => {
        if (
          window.confirm(
            `${error.message}\n\nForce close ${variables.year}-${variables.month} anyway?`,
          )
        ) {
          closePeriodMutation.mutate({ ...variables, force: true });
        }
      },
    }),
  );

  const reopenPeriodMutation = useMutation(
    trpc.ledger.reopenPeriod.mutationOptions({ onSuccess: invalidate }),
  );

  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-4">
      <YearSelect value={year} onChange={(y) => setYear(y ?? year)} />
      <Table className="max-w-xl">
        <TableHeader>
          <TableRow>
            <TableHead>Month</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Entries</TableHead>
            <TableHead className="text-right">To book</TableHead>
            <TableHead className="w-28" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data?.map((p) => (
            <TableRow key={p.month}>
              <TableCell>{MONTHS[p.month - 1]}</TableCell>
              <TableCell>
                {p.status === "closed" ? (
                  <span className="text-muted-foreground">Closed</span>
                ) : (
                  "Open"
                )}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {p.entries}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {p.unbooked > 0 ? p.unbooked : "—"}
              </TableCell>
              <TableCell className="text-right">
                {p.status === "closed" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      reopenPeriodMutation.mutate({ year, month: p.month })
                    }
                  >
                    Reopen
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={closePeriodMutation.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Close ${MONTHS[p.month - 1]} ${year}? Posting into a closed period is blocked.`,
                        )
                      ) {
                        closePeriodMutation.mutate({ year, month: p.month });
                      }
                    }}
                  >
                    Close
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function VatReturnTab() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [quarter, setQuarter] = useState(Math.floor(now.getMonth() / 3) + 1);
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.ledger.vatReturn.queryOptions({ year, quarter }),
  );
  const xmlQuery = useQuery({
    ...trpc.ledger.vatReturnXml.queryOptions({ year, quarter }),
    enabled: false,
  });

  const downloadXml = async () => {
    const { data: result, error } = await xmlQuery.refetch();
    if (error || !result) {
      window.alert(error?.message ?? "Failed to generate the Intervat XML");
      return;
    }
    const blob = new Blob([result.xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <YearSelect value={year} onChange={(y) => setYear(y ?? year)} />
        <select
          className="border bg-background px-2 py-1 text-sm"
          value={quarter}
          onChange={(e) => setQuarter(Number(e.target.value))}
        >
          {[1, 2, 3, 4].map((q) => (
            <option key={q} value={q}>
              Q{q}
            </option>
          ))}
        </select>
        <Button
          variant="outline"
          size="sm"
          disabled={xmlQuery.isFetching}
          onClick={downloadXml}
        >
          Download Intervat XML
        </Button>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {data?.warnings.map((w) => (
            <p key={w} className="text-xs text-muted-foreground">
              ⚠ {w}
            </p>
          ))}
          {Object.keys(data?.grids ?? {}).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No VAT-relevant activity in Q{quarter} {year}.
            </p>
          ) : (
            <Table className="max-w-md">
              <TableHeader>
                <TableRow>
                  <TableHead>Box</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(data?.grids ?? {}).map(([box, amount]) => (
                  <TableRow key={box}>
                    <TableCell className="font-mono">{box}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {amount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </div>
  );
}

export function AccountingContent() {
  const [tab, setTab] = useState("overview");
  const [glPreset, setGlPreset] = useState<GlPreset | null>(null);

  const drill = (preset: GlPreset) => {
    setGlPreset(preset);
    setTab("general-ledger");
  };

  return (
    <div className="max-w-[1200px]">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4 flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="income">Resultatenrekening</TabsTrigger>
          <TabsTrigger value="balance">Balans</TabsTrigger>
          <TabsTrigger value="vat">VAT return</TabsTrigger>
          <TabsTrigger value="periods">Periods</TabsTrigger>
          <TabsTrigger value="trial-balance">Trial balance</TabsTrigger>
          <TabsTrigger value="general-ledger">General ledger</TabsTrigger>
          <TabsTrigger value="open-items">Open items</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="income">
          <StatementTab kind="income" onDrill={drill} />
        </TabsContent>
        <TabsContent value="balance">
          <StatementTab kind="balance" onDrill={drill} />
        </TabsContent>
        <TabsContent value="vat">
          <VatReturnTab />
        </TabsContent>
        <TabsContent value="periods">
          <PeriodsTab />
        </TabsContent>
        <TabsContent value="trial-balance">
          <TrialBalanceTab />
        </TabsContent>
        <TabsContent value="general-ledger">
          <GeneralLedgerTab key={JSON.stringify(glPreset)} preset={glPreset} />
        </TabsContent>
        <TabsContent value="open-items">
          <OpenItemsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
