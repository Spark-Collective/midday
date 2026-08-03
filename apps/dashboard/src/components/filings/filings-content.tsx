"use client";

import { Button } from "@midday/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";

const KIND_LABELS: Record<string, string> = {
  vat_return: "VAT return",
  client_listing: "Client listing",
  ic_statement: "IC statement",
  annual_accounts: "Annual accounts",
  corporate_tax: "Corporate tax",
  personal_tax: "Personal tax",
  social_contribution: "Social contributions",
  advance_payment: "Advance payment",
};

const STATUS_LABELS: Record<string, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  ready_for_review: "Ready for review",
  filed: "Filed",
  confirmed: "Confirmed",
  skipped: "Skipped",
};

function periodLabel(periodKey: string) {
  const q = periodKey.match(/^(\d{4})Q(\d)$/);
  if (q) return `Q${q[2]} ${q[1]}`;
  const m = periodKey.match(/^(\d{4})M(\d{2})$/);
  if (m) return `${m[2]}/${m[1]}`;
  return periodKey;
}

/** Days until due; negative means overdue. */
function daysUntil(due: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round(
    (new Date(`${due}T00:00:00`).getTime() - today.getTime()) / 86400000,
  );
}

function DueBadge({ due, status }: { due: string; status: string }) {
  if (status === "filed" || status === "confirmed" || status === "skipped") {
    return <span className="text-xs text-[#878787]">{due}</span>;
  }
  const d = daysUntil(due);
  const tone =
    d < 0 ? "text-red-600" : d <= 14 ? "text-amber-600" : "text-[#878787]";
  const text =
    d < 0
      ? `overdue by ${Math.abs(d)}d`
      : d === 0
        ? "due today"
        : `due in ${d}d`;
  return (
    <span className={`text-xs ${tone}`}>
      {due} · {text}
    </span>
  );
}

type Filing = {
  id: string;
  kind: string;
  directorId?: string | null;
  periodKey: string;
  dueDate: string;
  status: string;
  directorName: string | null;
  externalRef: string | null;
  steps: Array<{ key: string; label: string; kind: string; status: string }>;
  data?: {
    grids?: Record<string, string>;
    probability?: Array<{ code: string; message: string; rule: string }>;
  } | null;
};

function StepList({ filing }: { filing: Filing }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const setStep = useMutation({
    ...trpc.filings.setStep.mutationOptions(),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: trpc.filings.list.queryKey() }),
  });

  return (
    <div className="mt-3 space-y-1.5 border-t border-border pt-3">
      {filing.steps.map((s) => {
        const done = s.status === "done";
        return (
          <button
            type="button"
            key={s.key}
            onClick={() =>
              setStep.mutate({
                filingId: filing.id,
                stepKey: s.key,
                status: done ? "todo" : "done",
              })
            }
            className="flex w-full items-center gap-2 text-left text-sm hover:opacity-70"
          >
            <span className={done ? "text-green-600" : "text-[#878787]"}>
              {done ? "✓" : "○"}
            </span>
            <span className={done ? "text-[#878787] line-through" : ""}>
              {s.label}
            </span>
            <span className="ml-auto text-xs text-[#878787]">
              {s.kind === "auto" ? "auto" : "you"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function VatPanel({ filing }: { filing: Filing }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const prepare = useMutation({
    ...trpc.filings.prepareVat.mutationOptions(),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: trpc.filings.list.queryKey() }),
  });
  const [confirming, setConfirming] = useState(false);
  const submit = useMutation({
    ...trpc.filings.submitVat.mutationOptions(),
    onSuccess: () => {
      setConfirming(false);
      qc.invalidateQueries({ queryKey: trpc.filings.list.queryKey() });
    },
  });
  const quarter = Number(filing.periodKey.match(/Q(\d)/)?.[1] ?? 0);
  const year = Number(filing.periodKey.slice(0, 4));
  const grids = filing.data?.grids;
  const probability = filing.data?.probability ?? [];

  return (
    <div className="mt-3 border-t border-border pt-3">
      <Button
        variant="outline"
        size="sm"
        disabled={prepare.isPending}
        onClick={() =>
          prepare.mutate({
            filingId: filing.id,
            year,
            ...(quarter
              ? { quarter }
              : { month: Number(filing.periodKey.slice(5)) }),
          })
        }
      >
        {prepare.isPending
          ? "Computing…"
          : grids
            ? "Recompute grids"
            : "Compute grids"}
      </Button>

      {grids && Object.keys(grids).length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
          {Object.entries(grids).map(([box, amount]) => (
            <span key={box}>
              <span className="text-[#878787]">{box}</span> {amount}
            </span>
          ))}
        </div>
      )}
      {grids && Object.keys(grids).length === 0 && (
        <p className="mt-3 text-sm text-[#878787]">
          No VAT-relevant activity in this period.
        </p>
      )}

      {probability.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-amber-600">
            {probability.length} warning{probability.length > 1 ? "s" : ""}{" "}
            Intervat will require you to justify:
          </p>
          {probability.map((w) => (
            <div key={w.code} className="border border-border p-2 text-xs">
              <p className="font-mono text-[#878787]">{w.code}</p>
              <p className="mt-1">{w.message}</p>
              <p className="mt-1 font-mono text-[#878787]">{w.rule}</p>
            </div>
          ))}
        </div>
      )}
      {grids && probability.length === 0 && (
        <p className="mt-3 text-xs text-green-600">
          No probability warnings. Intervat should accept this without
          justification.
        </p>
      )}

      {grids && Object.keys(grids).length > 0 && filing.status !== "filed" && (
        <div className="mt-4 border-t border-border pt-3">
          {confirming ? (
            <div className="space-y-2">
              <p className="text-sm">
                This files the {periodLabel(filing.periodKey)} VAT return with
                FOD Financiën. It cannot be undone; a mistake needs a corrective
                return.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={submit.isPending}
                  onClick={() =>
                    submit.mutate({
                      filingId: filing.id,
                      year,
                      ...(quarter
                        ? { quarter }
                        : { month: Number(filing.periodKey.slice(5)) }),
                      confirm: true,
                      env: "prod",
                      askRestitution: "NO",
                    })
                  }
                >
                  {submit.isPending ? "Submitting…" : "Yes, submit to Intervat"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={probability.length > 0}
              onClick={() => setConfirming(true)}
            >
              Submit to Intervat
            </Button>
          )}
          {probability.length > 0 && (
            <p className="mt-2 text-xs text-[#878787]">
              Resolve the warnings above first — Intervat would reject this.
            </p>
          )}
          {submit.error && (
            <p className="mt-2 text-xs text-red-600">{submit.error.message}</p>
          )}
        </div>
      )}

      {filing.status === "filed" && filing.externalRef && (
        <p className="mt-3 font-mono text-xs text-green-600">
          Filed · proof {filing.externalRef}
        </p>
      )}
    </div>
  );
}

function AnnualAccountsPanel({ filing }: { filing: Filing }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const prepare = useMutation({
    ...trpc.filings.prepareAnnualAccounts.mutationOptions(),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: trpc.filings.list.queryKey() }),
  });
  const year = Number(filing.periodKey.slice(0, 4));
  const data = filing.data as
    | {
        checks?: Array<{ name: string; ok: boolean; detail: string }>;
        blocking?: string[];
        xbrlFilename?: string | null;
      }
    | null
    | undefined;
  const failed = (data?.checks ?? []).filter((c) => !c.ok);

  return (
    <div className="mt-3 border-t border-border pt-3">
      <Button
        variant="outline"
        size="sm"
        disabled={prepare.isPending}
        onClick={() => prepare.mutate({ filingId: filing.id, year })}
      >
        {prepare.isPending
          ? "Mapping…"
          : data?.checks
            ? "Re-run mapping + controls"
            : "Map to the NBB model"}
      </Button>

      {data?.checks && (
        <p className="mt-3 text-sm">
          {failed.length === 0 ? (
            <span className="text-green-600">
              All {data.checks.length} Balanscentrale controls pass.
            </span>
          ) : (
            <span className="text-red-600">
              {failed.length} of {data.checks.length} controls fail — a deposit
              would be refused.
            </span>
          )}
        </p>
      )}

      {failed.length > 0 && (
        <div className="mt-2 space-y-1">
          {failed.map((c) => (
            <p key={c.name} className="text-xs text-red-600">
              {c.name}: {c.detail}
            </p>
          ))}
        </div>
      )}

      {data?.xbrlFilename && (
        <p className="mt-3 text-xs text-[#878787]">
          XBRL instance ready:{" "}
          <span className="font-mono">{data.xbrlFilename}</span>. Deposit it
          yourself on filing.cbso.nbb.be.
        </p>
      )}
      {data?.blocking && data.blocking.length > 0 && !data.xbrlFilename && (
        <p className="mt-2 text-xs text-amber-600">
          No instance built while controls fail.
        </p>
      )}
    </div>
  );
}

const eurFmt = new Intl.NumberFormat("nl-BE", {
  style: "currency",
  currency: "EUR",
});

function PersonalTaxPanel({ filing }: { filing: Filing }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { data: directors } = useQuery(trpc.owner.directors.queryOptions());
  const prepare = useMutation({
    ...trpc.filings.preparePersonalTax.mutationOptions(),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: trpc.filings.list.queryKey() }),
  });

  const incomeYear = Number(filing.periodKey.slice(0, 4));
  const directorId =
    filing.directorId ?? (directors?.[0]?.id as string | undefined);
  const data = filing.data as
    | {
        pack?: {
          lines?: Array<{
            vak: string;
            code: string;
            label: string;
            amount: number;
            source: string;
          }>;
          gaps?: string[];
        };
        computation?: {
          steps: Array<{ label: string; amount: number; note?: string }>;
          balance: number;
          averageRatePct: number;
          verified: boolean;
          warnings: string[];
        } | null;
        parameterGaps?: string[];
      }
    | null
    | undefined;

  return (
    <div className="mt-3 border-t border-border pt-3">
      <Button
        variant="outline"
        size="sm"
        disabled={prepare.isPending || !directorId}
        onClick={() =>
          directorId &&
          prepare.mutate({ filingId: filing.id, directorId, incomeYear })
        }
      >
        {prepare.isPending
          ? "Preparing…"
          : data?.pack
            ? "Recompute return"
            : "Prepare return"}
      </Button>
      {!directorId && (
        <p className="mt-2 text-xs text-[#878787]">
          No director on this team yet. Add one under Owner.
        </p>
      )}

      {data?.pack?.lines && data.pack.lines.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs text-[#878787]">
            Assembled from your books (income {incomeYear})
          </p>
          <div className="space-y-1">
            {data.pack.lines.map((l) => (
              <div
                key={`${l.code}-${l.label}`}
                className="flex items-baseline gap-2 text-sm"
              >
                <span className="font-mono text-xs text-[#878787]">
                  {l.vak} · {l.code}
                </span>
                <span>{l.label}</span>
                <span className="ml-auto font-mono tabular-nums">
                  {eurFmt.format(l.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data?.computation && (
        <div className="mt-4 border border-border p-3">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <span className="text-sm">Computation</span>
            {!data.computation.verified && (
              <span className="text-xs text-amber-600">
                unverified parameters — estimate
              </span>
            )}
          </div>
          <div className="space-y-1">
            {data.computation.steps.map((st) => (
              <div key={st.label} className="flex items-baseline gap-2 text-sm">
                <span
                  className={
                    st.label.startsWith("Te betalen") ||
                    st.label.startsWith("Terug")
                      ? ""
                      : "text-[#878787]"
                  }
                >
                  {st.label}
                </span>
                {st.note && (
                  <span className="font-mono text-xs text-[#878787]">
                    {st.note}
                  </span>
                )}
                <span className="ml-auto font-mono tabular-nums">
                  {eurFmt.format(st.amount)}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-[#878787]">
            Average rate {data.computation.averageRatePct}% · lay this beside
            the official assessment before filing.
          </p>
          {data.computation.warnings.map((w) => (
            <p key={w} className="mt-2 text-xs text-amber-600">
              {w}
            </p>
          ))}
        </div>
      )}

      {data?.parameterGaps && data.parameterGaps.length > 0 && (
        <div className="mt-3 border border-amber-600/40 bg-amber-600/5 p-3">
          <p className="text-xs text-amber-700 dark:text-amber-500">
            No tax computed — the parameter set is incomplete:
          </p>
          {data.parameterGaps.map((g) => (
            <p key={g} className="mt-1 text-xs text-[#878787]">
              {g}
            </p>
          ))}
        </div>
      )}

      {data?.pack?.gaps && data.pack.gaps.length > 0 && (
        <div className="mt-3 space-y-1">
          {data.pack.gaps.map((g) => (
            <p key={g} className="text-xs text-[#878787]">
              · {g}
            </p>
          ))}
        </div>
      )}

      <p className="mt-3 text-xs text-[#878787]">
        There is no API for the personal return: file it yourself in Tax-on-web
        using these figures.
      </p>
    </div>
  );
}

/**
 * Close the loop on anything filed outside the app (Tax-on-web, the NBB deposit,
 * a payment to the social fund). Evidence is required: the API refuses to record
 * "filed" without a reference, so the timeline can never claim something it
 * cannot show.
 */
function MarkFiledBox({ filing }: { filing: Filing }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState("");
  const mark = useMutation({
    ...trpc.filings.markFiled.mutationOptions(),
    onSuccess: () => {
      setOpen(false);
      setRef("");
      qc.invalidateQueries({ queryKey: trpc.filings.list.queryKey() });
    },
  });

  if (filing.status === "filed" || filing.status === "confirmed") {
    return (
      <p className="mt-3 border-t border-border pt-3 font-mono text-xs text-green-600">
        Filed · {filing.externalRef}
      </p>
    );
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      {open ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="h-9 w-72 border border-border bg-background px-3 text-sm"
            placeholder="Reference, deposit number or payment date"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!ref.trim() || mark.isPending}
            onClick={() =>
              mark.mutate({ filingId: filing.id, externalRef: ref.trim() })
            }
          >
            {mark.isPending ? "Saving…" : "Record as filed"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          I filed this myself
        </Button>
      )}
      {mark.error && (
        <p className="mt-2 text-xs text-red-600">{mark.error.message}</p>
      )}
    </div>
  );
}

/**
 * Social contributions and advance payments: no API to call, but the operator
 * still needs the amount, the deadline and somewhere to record the payment.
 */
function PaymentPanel({ filing }: { filing: Filing }) {
  const isSocial = filing.kind === "social_contribution";
  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="text-sm text-[#878787]">
        {isSocial
          ? "Quarterly provisional contribution to your social insurance fund. The amount comes from the fund, not from us: it is based on income from roughly three years ago and is regularised later."
          : "Optional prepayment against corporate tax. Paying enough across the four deadlines avoids a surcharge; the earlier quarters carry the larger benefit."}
      </p>
      <p className="mt-2 text-xs text-[#878787]">
        {isSocial
          ? "Pay it from the bank account so the transaction matches automatically, then record it here."
          : "Use the structured communication from your prepayment notice."}
      </p>
    </div>
  );
}
export function FilingsContent() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [openId, setOpenId] = useState<string | null>(null);
  const trpc = useTRPC();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery(
    trpc.filings.list.queryOptions({ year }),
  );
  const generate = useMutation({
    ...trpc.filings.generate.mutationOptions(),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: trpc.filings.list.queryKey() }),
  });

  const filings = (data ?? []) as Filing[];
  const open = filings.filter(
    (f) => !["filed", "confirmed", "skipped"].includes(f.status),
  );
  const closed = filings.filter((f) =>
    ["filed", "confirmed", "skipped"].includes(f.status),
  );

  return (
    <div className="max-w-[1000px]">
      <div className="flex items-center gap-2 py-6">
        <select
          className="h-9 border border-border bg-background px-3 text-sm"
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        >
          {[
            now.getFullYear() - 1,
            now.getFullYear(),
            now.getFullYear() + 1,
          ].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <Button
          variant="outline"
          size="sm"
          disabled={generate.isPending}
          onClick={() => generate.mutate({ year })}
        >
          {generate.isPending ? "Generating…" : "Generate obligations"}
        </Button>
      </div>

      {isLoading && <p className="text-sm text-[#878787]">Loading…</p>}

      {!isLoading && filings.length === 0 && (
        <p className="text-sm text-[#878787]">
          No obligations for {year} yet. Generate them to see the year ahead.
        </p>
      )}

      <div className="space-y-2">
        {open.map((f) => (
          <div key={f.id} className="border border-border">
            <button
              type="button"
              onClick={() => setOpenId(openId === f.id ? null : f.id)}
              className="flex w-full items-baseline justify-between gap-3 p-4 text-left hover:bg-secondary"
            >
              <div>
                <span className="text-sm">
                  {KIND_LABELS[f.kind] ?? f.kind} · {periodLabel(f.periodKey)}
                </span>
                {f.directorName && (
                  <span className="ml-2 text-xs text-[#878787]">
                    {f.directorName}
                  </span>
                )}
                <span className="ml-2 text-xs text-[#878787]">
                  {STATUS_LABELS[f.status]}
                </span>
              </div>
              <DueBadge due={f.dueDate} status={f.status} />
            </button>
            {openId === f.id && (
              <div className="px-4 pb-4">
                {f.kind === "vat_return" && <VatPanel filing={f} />}
                {f.kind === "personal_tax" && <PersonalTaxPanel filing={f} />}
                {f.kind === "annual_accounts" && (
                  <AnnualAccountsPanel filing={f} />
                )}
                {(f.kind === "social_contribution" ||
                  f.kind === "advance_payment") && <PaymentPanel filing={f} />}
                <StepList filing={f} />
                {f.kind !== "vat_return" && <MarkFiledBox filing={f} />}
              </div>
            )}
          </div>
        ))}
      </div>

      {closed.length > 0 && (
        <div className="mt-8">
          <p className="mb-2 text-xs text-[#878787]">Done</p>
          <div className="space-y-2">
            {closed.map((f) => (
              <div
                key={f.id}
                className="flex items-baseline justify-between gap-3 border border-border p-4 opacity-60"
              >
                <span className="text-sm">
                  {KIND_LABELS[f.kind] ?? f.kind} · {periodLabel(f.periodKey)}
                  <span className="ml-2 text-xs text-[#878787]">
                    {STATUS_LABELS[f.status]}
                  </span>
                </span>
                <span className="font-mono text-xs text-[#878787]">
                  {f.externalRef ?? f.dueDate}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
