"use client";

import { Button } from "@midday/ui/button";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { formatAmount } from "@/utils/format";
import {
  type Proposal,
  ProposalRow,
  type ProposalStatus,
} from "./proposal-row";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "accepted", label: "Accepted" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

export function ProposalsContent() {
  const trpc = useTRPC();
  const { data: user } = useUserQuery();
  const { data, isLoading } = useQuery(trpc.proposals.list.queryOptions({}));
  const [filter, setFilter] = useState<Filter>("all");

  const all = (data ?? []) as Proposal[];
  const rows = all.filter((p) =>
    filter === "all"
      ? true
      : filter === "accepted"
        ? p.status === "accepted"
        : p.status === "draft" || p.status === "sent",
  );

  const money = (n: number, currency: string) =>
    formatAmount({
      amount: n,
      currency,
      maximumFractionDigits: 0,
      locale: user?.locale,
    }) ?? String(n);

  // The two numbers worth seeing at the top of a pipeline: what is committed,
  // and what is still out there waiting on someone else.
  const sum = (s: ProposalStatus[]) =>
    all
      .filter((p) => s.includes(p.status))
      .reduce((t, p) => t + (p.oneOffAmount ?? 0), 0);
  const currency = all[0]?.currency ?? "EUR";

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4 py-6">
        <div className="flex gap-8">
          <div>
            <div className="text-xs text-[#878787]">Accepted</div>
            <div className="mt-1 text-xl font-medium">
              {money(sum(["accepted"]), currency)}
              <span className="ml-2 text-xs text-[#878787]">net</span>
            </div>
          </div>
          <div>
            <div className="text-xs text-[#878787]">Out for decision</div>
            <div className="mt-1 text-xl font-medium">
              {money(sum(["sent"]), currency)}
              <span className="ml-2 text-xs text-[#878787]">net</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <Button
              key={f.key}
              variant="ghost"
              size="sm"
              className={
                filter === f.key ? "text-foreground" : "text-muted-foreground"
              }
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="h-40 border border-border" />
      ) : rows.length === 0 ? (
        <p className="border border-border px-4 py-6 text-sm text-muted-foreground">
          Nothing here. Proposals are written from Claude Code; accepting one
          puts its revenue into the cash forecast.
        </p>
      ) : (
        <div className="border border-border">
          {rows.map((p) => (
            <ProposalRow key={p.id} proposal={p} money={money} />
          ))}
        </div>
      )}
    </div>
  );
}
