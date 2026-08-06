"use client";

import { Button } from "@midday/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { formatAmount } from "@/utils/format";

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
  expectedInvoiceDate: string | null;
  documentUrl: string | null;
  invoiced: number;
};

const STATUS_TONE: Record<Proposal["status"], string> = {
  draft: "text-muted-foreground",
  sent: "text-amber-600",
  accepted: "text-green-600",
  declined: "text-muted-foreground",
  expired: "text-red-600",
  withdrawn: "text-muted-foreground",
};

/** Only what the client can actually do next, so the UI cannot propose an illegal move. */
const NEXT: Record<Proposal["status"], Proposal["status"][]> = {
  draft: ["sent", "withdrawn"],
  sent: ["accepted", "declined", "expired"],
  accepted: [],
  declined: [],
  expired: ["sent"],
  withdrawn: [],
};

export function CustomerProposals({ customerId }: { customerId: string }) {
  const trpc = useTRPC();
  const { data: user } = useUserQuery();
  const { data } = useQuery(trpc.proposals.list.queryOptions({ customerId }));

  if (!data) return null;
  const proposals = data as Proposal[];

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
            <ProposalRow key={p.id} proposal={p} locale={user?.locale} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalRow({
  proposal,
  locale,
}: {
  proposal: Proposal;
  locale?: string | null;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [accepting, setAccepting] = useState(false);
  const [date, setDate] = useState(proposal.expectedInvoiceDate ?? "");

  const setStatus = useMutation({
    ...trpc.proposals.setStatus.mutationOptions(),
    onSuccess: () => {
      setAccepting(false);
      qc.invalidateQueries({ queryKey: trpc.proposals.list.queryKey() });
      qc.invalidateQueries({ queryKey: trpc.cashflow.forecast.queryKey() });
    },
  });

  const money = (n: number) =>
    formatAmount({
      amount: n,
      currency: proposal.currency,
      maximumFractionDigits: 0,
      locale,
    }) ?? String(n);

  const price = [
    proposal.oneOffAmount ? money(proposal.oneOffAmount) : null,
    proposal.recurringAmount && proposal.recurringInterval
      ? `${money(proposal.recurringAmount)}/${proposal.recurringInterval}`
      : null,
  ]
    .filter(Boolean)
    .join(" + ");

  return (
    <div className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="font-mono text-xs text-muted-foreground">
            {proposal.number}
          </span>
          <span className="ml-2 text-sm">{proposal.title}</span>
          <span className={`ml-2 text-xs ${STATUS_TONE[proposal.status]}`}>
            {proposal.status}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {proposal.invoiced > 0 && (
            <span className="text-xs text-muted-foreground">
              {money(proposal.invoiced)} invoiced
            </span>
          )}
          <span className="font-mono text-sm">{price}</span>
        </div>
      </div>

      {(proposal.validUntil || proposal.documentUrl) && (
        <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
          {proposal.validUntil && (
            <span>valid until {proposal.validUntil}</span>
          )}
          {proposal.documentUrl && (
            <a
              className="underline"
              href={proposal.documentUrl}
              target="_blank"
              rel="noreferrer"
            >
              document
            </a>
          )}
        </div>
      )}

      {accepting ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            Bill the one-off on
          </span>
          <input
            type="date"
            className="h-9 w-40 border border-border bg-background px-2 text-sm"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={(!!proposal.oneOffAmount && !date) || setStatus.isPending}
            onClick={() =>
              setStatus.mutate({
                proposalId: proposal.id,
                status: "accepted",
                expectedInvoiceDate: date || null,
              })
            }
          >
            Confirm accepted
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setAccepting(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        NEXT[proposal.status].length > 0 && (
          <div className="mt-2 flex items-center gap-1">
            {NEXT[proposal.status].map((next) => (
              <Button
                key={next}
                variant="ghost"
                size="sm"
                disabled={setStatus.isPending}
                onClick={() =>
                  next === "accepted"
                    ? setAccepting(true)
                    : setStatus.mutate({
                        proposalId: proposal.id,
                        status: next,
                      })
                }
              >
                {next === "sent" ? "Mark sent" : `Mark ${next}`}
              </Button>
            ))}
          </div>
        )
      )}

      {setStatus.error && (
        <p className="mt-2 text-xs text-red-600">{setStatus.error.message}</p>
      )}
    </div>
  );
}
