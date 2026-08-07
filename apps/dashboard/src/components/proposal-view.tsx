"use client";

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";
import { ProposalMarkdown } from "./proposal-markdown";

type Proposal = {
  id: string;
  number: string;
  title: string;
  status: "draft" | "sent" | "accepted" | "declined" | "expired" | "withdrawn";
  customerName: string | null;
  currency: string;
  oneOffAmount: number | null;
  recurringAmount: number | null;
  recurringInterval: "month" | "quarter" | "year" | null;
  recurringMonths: number | null;
  validUntil: string | null;
  vatRate: number;
  documentUrl: string | null;
  sentAt: string | null;
  decidedAt: string | null;
  bodyMd?: string | null;
  sla?: Record<string, unknown> | null;
};

const STATUS_LABEL: Record<string, string> = {
  sent: "Awaiting your decision",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
};

const money = (n: number, currency: string) =>
  new Intl.NumberFormat("nl-BE", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(n);

/** camelCase SLA keys read as prose: noticePeriodDays -> "Notice period days". */
function humanise(key: string) {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function ProposalView({ token }: { token: string }) {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.proposals.byToken.queryOptions({ token, countView: true }),
  );

  if (isLoading) {
    return <div className="mx-auto h-64 w-full max-w-3xl" />;
  }

  // Deliberately indistinguishable from "never existed": a withdrawn or draft
  // offer must not confirm itself to whoever holds the link.
  if (!data) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-24 text-center">
        <h1 className="text-[18px] font-medium">Proposal not available</h1>
        <p className="mt-2 text-[13px] text-[#606060]">
          This link is no longer valid. Please get in touch for a current
          version.
        </p>
      </div>
    );
  }

  const p = data as Proposal;
  const net = p.oneOffAmount ?? 0;
  const vat = net * (p.vatRate / 100);
  const sla = (p.sla ?? {}) as Record<string, unknown>;
  const slaEntries = Object.entries(sla).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-12">
      <div className="mb-8">
        <span className="font-mono text-[12px] text-[#606060]">{p.number}</span>
        <h1 className="mt-2 text-[22px] font-medium">{p.title}</h1>
        <p className="mt-1 text-[13px] text-[#606060]">
          {p.customerName ? `${p.customerName} · ` : ""}
          {STATUS_LABEL[p.status] ?? p.status}
        </p>
      </div>

      {(p.oneOffAmount || p.recurringAmount) && (
        <div className="mb-8 border border-border">
          {p.oneOffAmount ? (
            <div className="border-b border-border px-5 py-4 last:border-b-0">
              <div className="flex items-baseline justify-between">
                <span className="text-[13px] text-[#606060]">One-off</span>
                <span className="text-[18px] font-medium">
                  {money(net + vat, p.currency)}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-5 text-[12px] text-[#606060]">
                <span>Excl. VAT {money(net, p.currency)}</span>
                <span>
                  VAT {p.vatRate}% {money(vat, p.currency)}
                </span>
              </div>
            </div>
          ) : null}

          {p.recurringAmount && p.recurringInterval ? (
            <div className="px-5 py-4">
              <div className="flex items-baseline justify-between">
                <span className="text-[13px] text-[#606060]">
                  Recurring, per {p.recurringInterval}
                </span>
                <span className="text-[18px] font-medium">
                  {money(p.recurringAmount * (1 + p.vatRate / 100), p.currency)}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-5 text-[12px] text-[#606060]">
                <span>Excl. VAT {money(p.recurringAmount, p.currency)}</span>
                {p.recurringMonths ? (
                  <span>Committed term {p.recurringMonths} months</span>
                ) : (
                  <span>Until cancelled</span>
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {p.validUntil && (
        <p className="mb-8 text-[13px] text-[#606060]">
          Valid until {p.validUntil}
        </p>
      )}

      {slaEntries.length > 0 && (
        <div className="mb-8 border border-border px-5 py-4">
          <h2 className="mb-3 text-[14px] font-medium">Service level</h2>
          <dl className="space-y-2">
            {slaEntries.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-6 text-[13px]">
                <dt className="text-[#606060]">{humanise(k)}</dt>
                <dd className="text-right">{String(v)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {p.bodyMd ? (
        <ProposalMarkdown source={p.bodyMd} />
      ) : (
        <p className="text-[13px] text-[#606060]">
          The full document was sent separately.
        </p>
      )}

      {p.documentUrl && (
        <p className="mt-8">
          <a
            className="text-[13px] underline"
            href={p.documentUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open the signed document
          </a>
        </p>
      )}
    </div>
  );
}
