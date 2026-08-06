"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";

type Proposal = {
  id: string;
  number: string;
  title: string;
  status: "draft" | "sent" | "accepted" | "declined" | "expired" | "withdrawn";
  currency: string;
  oneOffAmount: number | null;
  recurringAmount: number | null;
  recurringInterval: "month" | "quarter" | "year" | null;
  recurringMonths: number | null;
  validUntil: string | null;
  vatRate: number;
  bodyMd?: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  sent: "Awaiting your decision",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
};

function money(n: number, currency: string) {
  return new Intl.NumberFormat("nl-BE", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(n);
}

/**
 * Minimal markdown: headings, bold, list items and paragraphs. The proposal body
 * is written by us, not by the client, so this renders rather than sanitises
 * arbitrary input, and it deliberately does not support raw HTML.
 */
function Markdown({ source }: { source: string }) {
  return (
    <div className="space-y-2 text-[13px] leading-relaxed text-[#606060]">
      {source.split("\n").map((line, i) => {
        const key = `${i}-${line.slice(0, 12)}`;
        const bold = (t: string) =>
          t.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
            part.startsWith("**") && part.endsWith("**") ? (
              <strong
                key={`${key}-${j}`}
                className="font-medium text-foreground"
              >
                {part.slice(2, -2)}
              </strong>
            ) : (
              part
            ),
          );
        if (line.startsWith("### "))
          return (
            <h4
              key={key}
              className="pt-2 text-[13px] font-medium text-foreground"
            >
              {line.slice(4)}
            </h4>
          );
        if (line.startsWith("## "))
          return (
            <h3
              key={key}
              className="pt-3 text-[14px] font-medium text-foreground"
            >
              {line.slice(3)}
            </h3>
          );
        if (line.startsWith("# "))
          return (
            <h2
              key={key}
              className="pt-2 text-[15px] font-medium text-foreground"
            >
              {line.slice(2)}
            </h2>
          );
        if (line.startsWith("- "))
          return (
            <li key={key} className="ml-4 list-disc">
              {bold(line.slice(2))}
            </li>
          );
        if (!line.trim()) return null;
        return <p key={key}>{bold(line)}</p>;
      })}
    </div>
  );
}

export function PortalProposals({ portalId }: { portalId: string }) {
  const trpc = useTRPC();
  const { data } = useQuery(trpc.proposals.portal.queryOptions({ portalId }));
  const [open, setOpen] = useState<string | null>(null);

  if (!data || data.length === 0) return null;
  const proposals = data as Proposal[];

  return (
    <div className="mb-10">
      <h2 className="mb-4 text-[16px] font-medium">Proposals</h2>
      <div className="overflow-hidden border border-border bg-background">
        {proposals.map((p) => {
          const net = p.oneOffAmount ?? 0;
          const vat = net * (p.vatRate / 100);
          const isOpen = open === p.id;
          return (
            <div key={p.id} className="border-b border-border last:border-b-0">
              <button
                type="button"
                className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left hover:bg-muted/40"
                onClick={() => setOpen(isOpen ? null : p.id)}
              >
                <div className="min-w-0">
                  <span className="font-mono text-[12px] text-[#606060]">
                    {p.number}
                  </span>
                  <span className="ml-2 text-[14px]">{p.title}</span>
                  <span className="ml-2 text-[12px] text-[#606060]">
                    {STATUS_LABEL[p.status] ?? p.status}
                  </span>
                </div>
                <div className="shrink-0 text-right">
                  {p.oneOffAmount ? (
                    <div className="text-[14px]">
                      {money(net + vat, p.currency)}
                      <span className="ml-1 text-[12px] text-[#606060]">
                        incl. {p.vatRate}% VAT
                      </span>
                    </div>
                  ) : null}
                  {p.recurringAmount && p.recurringInterval ? (
                    <div className="text-[12px] text-[#606060]">
                      {money(
                        p.recurringAmount * (1 + p.vatRate / 100),
                        p.currency,
                      )}{" "}
                      per {p.recurringInterval}
                    </div>
                  ) : null}
                </div>
              </button>

              {isOpen && (
                <div className="border-t border-border px-4 py-4">
                  {p.oneOffAmount ? (
                    <div className="mb-4 flex flex-wrap gap-6 text-[12px] text-[#606060]">
                      <span>
                        Excl. VAT{" "}
                        <span className="text-foreground">
                          {money(net, p.currency)}
                        </span>
                      </span>
                      <span>
                        VAT {p.vatRate}%{" "}
                        <span className="text-foreground">
                          {money(vat, p.currency)}
                        </span>
                      </span>
                      {p.validUntil && <span>Valid until {p.validUntil}</span>}
                    </div>
                  ) : null}
                  {p.bodyMd ? (
                    <Markdown source={p.bodyMd} />
                  ) : (
                    <p className="text-[13px] text-[#606060]">
                      The full document was sent separately.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
