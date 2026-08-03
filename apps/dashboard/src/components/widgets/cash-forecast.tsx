"use client";

import { Button } from "@midday/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Area,
  AreaChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { formatAmount } from "@/utils/format";

type CashLine = {
  date: string;
  amount: number;
  kind: "invoice" | "project" | "filing" | "run_rate";
  label: string;
  sourceId: string | null;
  estimated: boolean;
};

type Bucket = {
  start: string;
  end: string;
  granularity: "week" | "month";
  inflow: number;
  outflow: number;
  closing: number;
  lines: CashLine[];
};

const KIND_LABEL: Record<CashLine["kind"], string> = {
  invoice: "Invoice",
  project: "Landed work",
  filing: "Tax and social",
  run_rate: "Running costs",
};

function shortDate(d: string) {
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

export function CashForecast() {
  const trpc = useTRPC();
  const { data: user } = useUserQuery();
  const locale = user?.locale;
  const { data, isLoading } = useQuery(
    trpc.cashflow.forecast.queryOptions({ weeks: 13, months: 6 }),
  );
  const [showLanded, setShowLanded] = useState(false);

  if (isLoading || !data) {
    return <div className="mt-6 h-[260px] border border-border" />;
  }

  const buckets = data.buckets as Bucket[];
  const money = (n: number) =>
    formatAmount({
      amount: n,
      currency: data.currency,
      maximumFractionDigits: 0,
      locale,
    }) ?? String(n);

  const chart = [
    { label: "now", closing: data.openingBalance },
    ...buckets.map((b) => ({ label: shortDate(b.end), closing: b.closing })),
  ];

  // The next dated movements, which is what you actually plan around. Running
  // costs are spread rather than dated, so they would only add noise here.
  const upcoming = buckets
    .flatMap((b) => b.lines)
    .filter((l) => l.kind !== "run_rate")
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 8);

  const goesNegative = data.lowest && data.lowest.balance < 0;

  return (
    <div className="mt-6 border border-border">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border p-5">
        <div>
          <span className="text-xs text-muted-foreground">Cash forecast</span>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-xl font-medium">
              {money(data.lowest?.balance ?? data.openingBalance)}
            </span>
            <span
              className={`text-xs ${goesNegative ? "text-red-600" : "text-muted-foreground"}`}
            >
              {data.lowest
                ? `lowest point, week of ${shortDate(data.lowest.date)}`
                : "no movements ahead"}
            </span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowLanded((v) => !v)}
        >
          {showLanded ? "Hide landed work" : "Landed work"}
        </Button>
      </div>

      <div className="h-[180px] w-full px-2 pt-4">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={chart}
            margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          >
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#878787" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              minTickGap={28}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#878787" }}
              tickLine={false}
              axisLine={false}
              width={52}
              tickFormatter={(v: number) => money(v)}
            />
            <ReferenceLine y={0} stroke="#dc2626" strokeDasharray="3 3" />
            <Tooltip
              formatter={(v) => money(Number(v))}
              contentStyle={{ fontSize: 12 }}
            />
            <Area
              type="monotone"
              dataKey="closing"
              stroke="currentColor"
              fill="currentColor"
              fillOpacity={0.08}
              strokeWidth={1.5}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {showLanded ? (
        <LandedWork />
      ) : (
        <div className="border-t border-border">
          {upcoming.map((l) => (
            <div
              key={`${l.kind}-${l.sourceId}-${l.date}`}
              className="flex items-center justify-between border-b border-border px-5 py-2 last:border-b-0"
            >
              <div className="min-w-0">
                <span className="truncate text-sm">{l.label}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {KIND_LABEL[l.kind]}
                  {l.estimated ? " · estimated" : ""}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  {shortDate(l.date)}
                </span>
                <span
                  className={`font-mono text-sm ${l.amount < 0 ? "text-red-600" : ""}`}
                >
                  {money(l.amount)}
                </span>
              </div>
            </div>
          ))}
          {upcoming.length === 0 && (
            <p className="px-5 py-4 text-xs text-muted-foreground">
              Nothing dated ahead. Add expected invoice dates to your landed
              work so the curve means something.
            </p>
          )}
        </div>
      )}

      {data.warnings.length > 0 && (
        <div className="border-t border-border px-5 py-3">
          {data.warnings.map((w: string) => (
            <p key={w} className="text-xs text-amber-600">
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** Where you say "we landed this, it will be invoiced around then, for this much". */
function LandedWork() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { data: projects } = useQuery(trpc.cashflow.pipeline.queryOptions());
  const save = useMutation({
    ...trpc.cashflow.setExpectedInvoice.mutationOptions(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: trpc.cashflow.forecast.queryKey() });
      qc.invalidateQueries({ queryKey: trpc.cashflow.pipeline.queryKey() });
    },
  });

  if (!projects) return <div className="h-24 border-t border-border" />;

  return (
    <div className="border-t border-border">
      {projects.map((p: Record<string, unknown>) => (
        <LandedRow
          key={String(p.id)}
          project={p}
          onSave={(expectedInvoiceDate, contractValue) =>
            save.mutate({
              projectId: String(p.id),
              expectedInvoiceDate,
              contractValue,
            })
          }
          saving={save.isPending}
        />
      ))}
      {projects.length === 0 && (
        <p className="px-5 py-4 text-xs text-muted-foreground">
          No open projects. Landed work is tracked as a project.
        </p>
      )}
      {save.error && (
        <p className="px-5 py-2 text-xs text-red-600">{save.error.message}</p>
      )}
    </div>
  );
}

function LandedRow({
  project,
  onSave,
  saving,
}: {
  project: Record<string, unknown>;
  onSave: (date: string | null, value: number | null) => void;
  saving: boolean;
}) {
  const [date, setDate] = useState(
    (project.expected_invoice_date as string) ?? "",
  );
  const [value, setValue] = useState(
    project.contract_value !== null && project.contract_value !== undefined
      ? String(project.contract_value)
      : "",
  );
  const invoiced = Number(project.invoiced ?? 0);
  const dirty =
    date !== ((project.expected_invoice_date as string) ?? "") ||
    value !==
      (project.contract_value !== null && project.contract_value !== undefined
        ? String(project.contract_value)
        : "");

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <span className="truncate text-sm">{String(project.name)}</span>
        {project.customer_name ? (
          <span className="ml-2 text-xs text-muted-foreground">
            {String(project.customer_name)}
          </span>
        ) : null}
        {invoiced > 0 ? (
          <span className="ml-2 text-xs text-muted-foreground">
            {invoiced.toFixed(0)} invoiced
          </span>
        ) : null}
      </div>
      <input
        type="date"
        className="h-9 w-40 border border-border bg-background px-2 text-sm"
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      <input
        type="number"
        min={0}
        placeholder="Value"
        className="h-9 w-28 border border-border bg-background px-2 text-sm"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={!dirty || saving}
        onClick={() =>
          onSave(date || null, value === "" ? null : Number(value))
        }
      >
        Save
      </Button>
    </div>
  );
}
