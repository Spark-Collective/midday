"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTRPC } from "@/trpc/client";
import { formatMoney as money, STATUS_LABEL } from "./proposal-blocks";

type Proposal = {
  id: string;
  token: string;
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
};

export function PortalProposals({ portalId }: { portalId: string }) {
  const trpc = useTRPC();
  const { data } = useQuery(trpc.proposals.portal.queryOptions({ portalId }));

  if (!data || data.length === 0) return null;
  const proposals = data as Proposal[];

  return (
    <div className="mb-10">
      <h2 className="mb-4 text-[16px] font-medium">Proposals</h2>
      <div className="overflow-hidden border border-border bg-background">
        {proposals.map((p) => {
          const net = p.oneOffAmount ?? 0;
          const gross = net * (1 + p.vatRate / 100);
          return (
            <Link
              key={p.id}
              href={`/pr/${p.token}`}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 last:border-b-0 hover:bg-muted/40"
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
                    {money(gross, p.currency)}
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
            </Link>
          );
        })}
      </div>
    </div>
  );
}
