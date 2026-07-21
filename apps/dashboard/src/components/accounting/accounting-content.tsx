"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@midday/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@midday/ui/tabs";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";

const eur = new Intl.NumberFormat("nl-BE", {
  style: "currency",
  currency: "EUR",
});

function Amount({ value }: { value: number }) {
  return (
    <span className="font-mono tabular-nums">
      {value === 0 ? "—" : eur.format(value)}
    </span>
  );
}

function TrialBalanceTab() {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.ledger.trialBalance.queryOptions({}),
  );
  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!data?.length)
    return (
      <p className="text-sm text-muted-foreground">
        No posted entries yet. The ledger fills as invoices and transactions
        post.
      </p>
    );
  const totals = data.reduce(
    (t, r) => ({ debit: t.debit + r.debit, credit: t.credit + r.credit }),
    { debit: 0, credit: 0 },
  );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-24">Account</TableHead>
          <TableHead>Name</TableHead>
          <TableHead className="text-right">Debit</TableHead>
          <TableHead className="text-right">Credit</TableHead>
          <TableHead className="text-right">Balance</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((r) => (
          <TableRow key={r.accountId}>
            <TableCell className="font-mono">{r.code}</TableCell>
            <TableCell>{r.name}</TableCell>
            <TableCell className="text-right">
              <Amount value={r.debit} />
            </TableCell>
            <TableCell className="text-right">
              <Amount value={r.credit} />
            </TableCell>
            <TableCell className="text-right">
              <Amount value={r.balance} />
            </TableCell>
          </TableRow>
        ))}
        <TableRow className="font-medium">
          <TableCell colSpan={2}>Total</TableCell>
          <TableCell className="text-right">
            <Amount value={totals.debit} />
          </TableCell>
          <TableCell className="text-right">
            <Amount value={totals.credit} />
          </TableCell>
          <TableCell className="text-right">
            <Amount value={totals.debit - totals.credit} />
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

function GeneralLedgerTab() {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.ledger.generalLedger.queryOptions({ limit: 200 }),
  );
  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!data?.length)
    return (
      <p className="text-sm text-muted-foreground">No ledger lines yet.</p>
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-28">Date</TableHead>
          <TableHead className="w-28">Entry</TableHead>
          <TableHead className="w-24">Account</TableHead>
          <TableHead>Description</TableHead>
          <TableHead className="text-right">Debit</TableHead>
          <TableHead className="text-right">Credit</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((r) => (
          <TableRow
            key={`${r.entryId}-${r.accountCode}-${r.debit}-${r.credit}`}
          >
            <TableCell>{r.date}</TableCell>
            <TableCell className="font-mono">{r.entryNumber ?? "—"}</TableCell>
            <TableCell className="font-mono" title={r.accountName}>
              {r.accountCode}
            </TableCell>
            <TableCell className="max-w-96 truncate">{r.description}</TableCell>
            <TableCell className="text-right">
              <Amount value={r.debit} />
            </TableCell>
            <TableCell className="text-right">
              <Amount value={r.credit} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function OpenItemsTab() {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(trpc.ledger.openItems.queryOptions({}));
  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!data?.length)
    return (
      <p className="text-sm text-muted-foreground">
        No open items — everything is reconciled.
      </p>
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-28">Date</TableHead>
          <TableHead className="w-24">Account</TableHead>
          <TableHead>Description</TableHead>
          <TableHead className="text-right">Open amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((r) => (
          <TableRow key={r.lineId}>
            <TableCell>{r.date}</TableCell>
            <TableCell className="font-mono">{r.accountCode}</TableCell>
            <TableCell className="max-w-96 truncate">{r.description}</TableCell>
            <TableCell className="text-right">
              <Amount value={r.residual} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function VatReturnTab() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [quarter, setQuarter] = useState(Math.floor(now.getMonth() / 3) + 1);
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.ledger.vatReturn.queryOptions({ year, quarter }),
  );
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <select
          className="border bg-background px-2 py-1 text-sm"
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        >
          {[now.getFullYear() - 1, now.getFullYear()].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <select
          className="border bg-background px-2 py-1 text-sm"
          value={quarter}
          onChange={(e) => setQuarter(Number(e.target.value))}
        >
          {[1, 2, 3, 4].map((q) => (
            <option key={q} value={q}>
              Q{q}
            </option>
          ))}
        </select>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {data?.warnings.map((w) => (
            <p key={w} className="text-xs text-muted-foreground">
              ⚠ {w}
            </p>
          ))}
          {Object.keys(data?.grids ?? {}).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No VAT-relevant activity in Q{quarter} {year}.
            </p>
          ) : (
            <Table className="max-w-md">
              <TableHeader>
                <TableRow>
                  <TableHead>Box</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(data?.grids ?? {}).map(([box, amount]) => (
                  <TableRow key={box}>
                    <TableCell className="font-mono">{box}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {amount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </div>
  );
}

export function AccountingContent() {
  return (
    <div className="max-w-[1000px]">
      <Tabs defaultValue="trial-balance">
        <TabsList className="mb-4">
          <TabsTrigger value="trial-balance">Trial balance</TabsTrigger>
          <TabsTrigger value="general-ledger">General ledger</TabsTrigger>
          <TabsTrigger value="open-items">Open items</TabsTrigger>
          <TabsTrigger value="vat">VAT return</TabsTrigger>
        </TabsList>
        <TabsContent value="trial-balance">
          <TrialBalanceTab />
        </TabsContent>
        <TabsContent value="general-ledger">
          <GeneralLedgerTab />
        </TabsContent>
        <TabsContent value="open-items">
          <OpenItemsTab />
        </TabsContent>
        <TabsContent value="vat">
          <VatReturnTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
