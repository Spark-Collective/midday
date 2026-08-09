"use client";

import { useQuery } from "@tanstack/react-query";
import {
  type Proposal,
  ProposalRow,
} from "@/components/proposals/proposal-row";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { formatAmount } from "@/utils/format";

/** The /proposals list scoped to one client, inside the customer sheet. */
export function CustomerProposals({ customerId }: { customerId: string }) {
  const trpc = useTRPC();
  const { data: user } = useUserQuery();
  const { data } = useQuery(trpc.proposals.list.queryOptions({ customerId }));

  if (!data) return null;
  const proposals = data as Proposal[];

  const money = (n: number, currency: string) =>
    formatAmount({
      amount: n,
      currency,
      maximumFractionDigits: 0,
      locale: user?.locale,
    }) ?? String(n);

  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">Proposals</h3>
        <span className="text-xs text-muted-foreground">
          {proposals.length === 0
            ? "none yet"
            : `${proposals.filter((p) => p.status === "accepted").length} accepted`}
        </span>
      </div>

      {proposals.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Proposals are written from Claude Code. Once one is accepted, its
          revenue appears in the cash forecast.
        </p>
      ) : (
        <div className="mt-3 border border-border">
          {proposals.map((p) => (
            <ProposalRow key={p.id} proposal={p} money={money} />
          ))}
        </div>
      )}
    </div>
  );
}
