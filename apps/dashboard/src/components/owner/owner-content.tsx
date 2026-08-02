"use client";

import { Button } from "@midday/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";

const eur = new Intl.NumberFormat("nl-BE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});
const eur2 = new Intl.NumberFormat("nl-BE", {
  style: "currency",
  currency: "EUR",
});

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border p-4">
      <p className="mb-1 text-xs text-[#878787]">{label}</p>
      <p className="font-mono text-xl tabular-nums">{value}</p>
    </div>
  );
}

export function OwnerContent() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [directorId, setDirectorId] = useState<string | null>(null);
  const trpc = useTRPC();
  const qc = useQueryClient();

  const { data: directors, isLoading: loadingDirectors } = useQuery(
    trpc.owner.directors.queryOptions(),
  );
  const active = directorId ?? directors?.[0]?.id ?? null;

  const { data: summary, isLoading } = useQuery({
    ...trpc.owner.summary.queryOptions({ directorId: active!, year }),
    enabled: !!active,
  });

  const link = useMutation({
    ...trpc.owner.linkAccounts.mutationOptions(),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: trpc.owner.summary.queryKey() }),
  });

  if (loadingDirectors) {
    return <p className="text-sm text-[#878787]">Loading…</p>;
  }

  if (!directors?.length) {
    return (
      <p className="text-sm text-[#878787]">
        No directors yet. Add one to track remuneration, benefits and social
        contributions.
      </p>
    );
  }

  return (
    <div className="max-w-[1000px]">
      <div className="mb-6 flex items-center gap-2">
        {directors.length > 1 && (
          <select
            className="border border-border bg-background px-2 py-1 text-sm"
            value={active ?? ""}
            onChange={(e) => setDirectorId(e.target.value)}
          >
            {directors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
        <select
          className="border border-border bg-background px-2 py-1 text-sm"
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        >
          {[now.getFullYear() - 1, now.getFullYear()].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>

      {isLoading && <p className="text-sm text-[#878787]">Loading…</p>}

      {summary && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric
              label="Remuneration YTD"
              value={eur.format(summary.remuneration.postedYtd)}
            />
            <Metric
              label="Benefits in kind"
              value={eur.format(summary.benefitsTotal)}
            />
            <Metric
              label="Social contributions"
              value={eur.format(summary.socialContributionsYtd)}
            />
            <Metric
              label="Advance payments"
              value={eur.format(summary.advancePaymentsYtd)}
            />
          </div>

          {summary.threshold && (
            <div className="border border-border p-4">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <span className="text-sm">
                  Threshold for the reduced corporate rate
                </span>
                {summary.threshold.parameter.stale && (
                  <a
                    href={summary.threshold.parameter.sourceUrl ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-amber-600 underline"
                  >
                    verify live
                  </a>
                )}
              </div>
              <div className="h-2 w-full bg-secondary">
                <div
                  className="h-full bg-primary"
                  style={{ width: `${Math.min(100, summary.threshold.pct)}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-[#878787]">
                {eur.format(summary.threshold.remunerationCounted)} of{" "}
                {eur.format(summary.threshold.value)} ·{" "}
                {summary.remuneration.monthsPosted} months posted
                {summary.remuneration.behindPlan
                  ? ` · ${eur.format(summary.remuneration.behindPlan)} behind plan`
                  : summary.director.remunerationMonthly
                    ? " · on plan"
                    : ""}
              </p>
            </div>
          )}

          {summary.benefits.some((b) => b.amount !== 0) && (
            <div className="border border-border p-4">
              <p className="mb-3 text-sm">Benefits in kind</p>
              <div className="space-y-1.5">
                {summary.benefits
                  .filter((b) => b.amount !== 0)
                  .map((b) => (
                    <div key={b.key} className="flex justify-between text-sm">
                      <span className="text-[#878787]">{b.label}</span>
                      <span className="font-mono tabular-nums">
                        {eur2.format(b.amount)}
                      </span>
                    </div>
                  ))}
              </div>
              <p className="mt-3 text-xs text-[#878787]">
                Net of amounts already recovered from you. These land on your
                fiche 281.20 and in your personal return.
              </p>
            </div>
          )}

          <div className="border border-border p-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm">
                Current account
                {summary.currentAccount.accountCode && (
                  <span className="ml-2 font-mono text-xs text-[#878787]">
                    {summary.currentAccount.accountCode}
                  </span>
                )}
              </span>
              <span
                className={`font-mono tabular-nums ${
                  summary.currentAccount.direction === "debit"
                    ? "text-red-600"
                    : "text-green-600"
                }`}
              >
                {eur2.format(summary.currentAccount.balance)}
              </span>
            </div>
            <p className="mt-2 text-xs text-[#878787]">
              {summary.currentAccount.direction === "credit"
                ? "In credit: the company owes you."
                : summary.currentAccount.direction === "debit"
                  ? "In debit: you owe the company."
                  : "Settled."}
            </p>
            {summary.currentAccount.warning && (
              <p className="mt-2 border border-red-600/40 bg-red-600/5 p-2 text-xs text-red-600">
                {summary.currentAccount.warning}
              </p>
            )}
          </div>

          <div className="border border-border p-4">
            <p className="mb-2 text-sm">Withholding paid</p>
            <p className="font-mono text-sm tabular-nums">
              {eur2.format(summary.withholdingYtd)}
            </p>
            <p className="mt-2 text-xs text-[#878787]">
              Credited against your personal income tax.
            </p>
          </div>

          {summary.unmappedAccounts.length > 0 && (
            <div className="border border-amber-600/40 bg-amber-600/5 p-4">
              <p className="text-sm text-amber-700 dark:text-amber-500">
                {summary.unmappedAccounts.length} account
                {summary.unmappedAccounts.length > 1 ? "s" : ""} not found in
                your chart
              </p>
              <p className="mt-1 text-xs text-[#878787]">
                {summary.unmappedAccounts.join(" · ")}
              </p>
              <p className="mt-2 text-xs text-[#878787]">
                Amounts posted to these would be missing here. Link them if your
                chart uses them.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                disabled={link.isPending}
                onClick={() => link.mutate()}
              >
                {link.isPending ? "Linking…" : "Link standard accounts"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
