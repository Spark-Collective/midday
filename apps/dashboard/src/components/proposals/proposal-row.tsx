"use client";

import { Button } from "@midday/ui/button";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";

export type ProposalStatus =
  | "draft"
  | "sent"
  | "accepted"
  | "declined"
  | "expired"
  | "withdrawn";

export type Proposal = {
  id: string;
  token: string;
  number: string;
  title: string;
  status: ProposalStatus;
  customerName: string | null;
  currency: string;
  oneOffAmount: number | null;
  recurringAmount: number | null;
  recurringInterval: "month" | "quarter" | "year" | null;
  recurringMonths: number | null;
  validUntil: string | null;
  expectedInvoiceDate: string | null;
  vatRate: number;
  invoiced: number;
  sentAt: string | null;
  decidedAt: string | null;
};

const TONE: Record<ProposalStatus, string> = {
  draft: "text-[#878787]",
  sent: "text-amber-600",
  accepted: "text-green-600",
  declined: "text-[#878787]",
  expired: "text-red-600",
  withdrawn: "text-[#878787]",
};

/** Only moves the lifecycle actually allows, so the UI cannot offer an illegal one. */
const NEXT: Record<ProposalStatus, ProposalStatus[]> = {
  draft: ["sent", "withdrawn"],
  sent: ["accepted", "declined", "expired"],
  accepted: [],
  declined: [],
  expired: ["sent"],
  withdrawn: [],
};

/**
 * One proposal row with its lifecycle actions, shared by the /proposals page
 * and the customer sheet so the two can never drift apart again.
 */
export function ProposalRow({
  proposal,
  money,
}: {
  proposal: Proposal;
  money: (n: number, c: string) => string;
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

  const net = proposal.oneOffAmount ?? 0;
  const price = [
    proposal.oneOffAmount ? money(net, proposal.currency) : null,
    proposal.recurringAmount && proposal.recurringInterval
      ? `${money(proposal.recurringAmount, proposal.currency)}/${proposal.recurringInterval}`
      : null,
  ]
    .filter(Boolean)
    .join(" + ");

  return (
    <div className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href={`/pr/${proposal.token}`}
          target="_blank"
          className="min-w-0 hover:underline"
        >
          <span className="font-mono text-xs text-[#878787]">
            {proposal.number}
          </span>
          <span className="ml-2 text-sm">{proposal.title}</span>
          <span className={`ml-2 text-xs ${TONE[proposal.status]}`}>
            {proposal.status}
          </span>
        </Link>
        <div className="flex shrink-0 items-center gap-3">
          {proposal.customerName && (
            <span className="text-xs text-[#878787]">
              {proposal.customerName}
            </span>
          )}
          <span className="font-mono text-sm">{price}</span>
        </div>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-[#878787]">
        {net > 0 && (
          <span>
            {money(net * (1 + proposal.vatRate / 100), proposal.currency)} incl.{" "}
            {proposal.vatRate}% VAT
          </span>
        )}
        {proposal.expectedInvoiceDate && (
          <span>bill {proposal.expectedInvoiceDate}</span>
        )}
        {proposal.validUntil && <span>valid until {proposal.validUntil}</span>}
        {proposal.invoiced > 0 && (
          <span>{money(proposal.invoiced, proposal.currency)} invoiced</span>
        )}
      </div>

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
