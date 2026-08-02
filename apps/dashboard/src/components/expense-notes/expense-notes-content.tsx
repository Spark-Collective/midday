"use client";

import { Button } from "@midday/ui/button";
import { Input } from "@midday/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
} from "@midday/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@midday/ui/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";

const eur = new Intl.NumberFormat("nl-BE", {
  style: "currency",
  currency: "EUR",
});

/** Cost accounts an onkostennota realistically claims. */
const ACCOUNTS = [
  { code: "611901", label: "Brandstof/elektriciteit wagen" },
  { code: "612900", label: "Onthaalkosten" },
  { code: "612910", label: "Restaurantkosten" },
  { code: "613010", label: "Parking & tol" },
  { code: "613050", label: "Trein, tram & bus" },
  { code: "611010", label: "Computerbenodigdheden" },
  { code: "611100", label: "Boeken & documentatie" },
  { code: "616200", label: "Telefoon, GSM & internet" },
];

type DraftLine = {
  description: string;
  periodLabel: string;
  category: string;
  glAccountCode: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  claimPct: string;
  amount: string;
  basisNote: string;
};

const emptyLine = (): DraftLine => ({
  description: "",
  periodLabel: "",
  category: "Energiekosten",
  glAccountCode: "611901",
  quantity: "",
  unit: "kWh",
  unitPrice: "",
  claimPct: "100",
  amount: "",
  basisNote: "",
});

const num = (s: string) => (s.trim() === "" ? undefined : Number(s));

/** Mirrors computeLineAmount server-side so the form previews the real total. */
function lineAmount(l: DraftLine): number {
  const pct = num(l.claimPct) ?? 100;
  const q = num(l.quantity);
  const p = num(l.unitPrice);
  const gross = q != null && p != null ? q * p : (num(l.amount) ?? 0);
  return Math.round(gross * (pct / 100) * 100) / 100;
}

function CreateSheet({ onClose }: { onClose: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [issueDate, setIssueDate] = useState(today);
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const trpc = useTRPC();
  const qc = useQueryClient();

  const create = useMutation(
    trpc.expenseNotes.create.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: trpc.expenseNotes.list.queryKey() });
        onClose();
      },
    }),
  );

  const total = lines.reduce((s, l) => s + lineAmount(l), 0);
  const set = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
        <SheetHeader className="mb-6">
          <h2 className="text-lg">Nieuwe onkostennota</h2>
          <p className="text-sm text-muted-foreground">
            Kosten die je privé betaalde en terugvordert. Geen btw: de
            leveranciersfactuur staat op je eigen naam.
          </p>
        </SheetHeader>

        <div className="grid grid-cols-3 gap-3">
          <label className="text-xs text-muted-foreground">
            Opmaakdatum
            <Input
              type="date"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Start periode
            <Input
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Einde periode
            <Input
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
            />
          </label>
        </div>

        <div className="mt-6 space-y-4">
          {lines.map((l, i) => (
            <div key={`line-${i}`} className="border p-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-muted-foreground">
                  Omschrijving
                  <Input
                    value={l.description}
                    placeholder="thuisladen tesla Q4"
                    onChange={(e) => set(i, { description: e.target.value })}
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  Periode
                  <Input
                    value={l.periodLabel}
                    placeholder="Q4 2026"
                    onChange={(e) => set(i, { periodLabel: e.target.value })}
                  />
                </label>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <label className="text-xs text-muted-foreground">
                  Rekening
                  <select
                    className="h-9 w-full border bg-background px-2 text-sm"
                    value={l.glAccountCode}
                    onChange={(e) => set(i, { glAccountCode: e.target.value })}
                  >
                    {ACCOUNTS.map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.code} {a.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-muted-foreground">
                  Categorie (op het document)
                  <Input
                    value={l.category}
                    onChange={(e) => set(i, { category: e.target.value })}
                  />
                </label>
              </div>
              <div className="mt-3 grid grid-cols-5 gap-2">
                <label className="text-xs text-muted-foreground">
                  Hoeveelheid
                  <Input
                    value={l.quantity}
                    placeholder="342"
                    onChange={(e) => set(i, { quantity: e.target.value })}
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  Eenheid
                  <Input
                    value={l.unit}
                    onChange={(e) => set(i, { unit: e.target.value })}
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  Tarief
                  <Input
                    value={l.unitPrice}
                    placeholder="0.2872"
                    onChange={(e) => set(i, { unitPrice: e.target.value })}
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  Of bedrag
                  <Input
                    value={l.amount}
                    placeholder="200.00"
                    onChange={(e) => set(i, { amount: e.target.value })}
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  Beroep %
                  <Input
                    value={l.claimPct}
                    onChange={(e) => set(i, { claimPct: e.target.value })}
                  />
                </label>
              </div>
              <label className="mt-3 block text-xs text-muted-foreground">
                Bron van het tarief (verschijnt op het document)
                <Input
                  value={l.basisNote}
                  placeholder="CREG forfait Q4 2026 Vlaanderen"
                  onChange={(e) => set(i, { basisNote: e.target.value })}
                />
              </label>
              <div className="mt-2 flex items-center justify-between">
                <span className="font-mono text-sm tabular-nums">
                  {eur.format(lineAmount(l))}
                </span>
                {lines.length > 1 && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline"
                    onClick={() =>
                      setLines((ls) => ls.filter((_, j) => j !== i))
                    }
                  >
                    verwijder lijn
                  </button>
                )}
              </div>
            </div>
          ))}
          <Button
            variant="outline"
            onClick={() => setLines((ls) => [...ls, emptyLine()])}
          >
            Lijn toevoegen
          </Button>
        </div>

        <label className="mt-6 block text-xs text-muted-foreground">
          Notities
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        <div className="mt-6 flex items-center justify-between border-t pt-4">
          <span className="text-sm">
            Totaal{" "}
            <span className="font-mono tabular-nums">{eur.format(total)}</span>
          </span>
          <Button
            disabled={create.isPending || total <= 0}
            onClick={() =>
              create.mutate({
                issueDate,
                periodStart: periodStart || undefined,
                periodEnd: periodEnd || undefined,
                notes: notes || undefined,
                lines: lines.map((l) => ({
                  description: l.description || "Onkosten",
                  glAccountCode: l.glAccountCode,
                  periodLabel: l.periodLabel || undefined,
                  category: l.category || undefined,
                  quantity: num(l.quantity),
                  unit: l.unit || undefined,
                  unitPrice: num(l.unitPrice),
                  claimPct: num(l.claimPct),
                  amount: num(l.amount),
                  basisNote: l.basisNote || undefined,
                })),
              })
            }
          >
            {create.isPending ? "Bezig..." : "Aanmaken"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function ExpenseNotesContent() {
  const [creating, setCreating] = useState(false);
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery(
    trpc.expenseNotes.list.queryOptions({}),
  );
  const post = useMutation(
    trpc.expenseNotes.post.mutationOptions({
      onSuccess: () =>
        qc.invalidateQueries({ queryKey: trpc.expenseNotes.list.queryKey() }),
    }),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg">Onkostennota's</h1>
          <p className="text-sm text-muted-foreground">
            Privé betaalde kosten terugvorderen. Boeking: kostenrekening tegen
            je rekening-courant, geen btw.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>Nieuwe onkostennota</Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Laden...</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nummer</TableHead>
              <TableHead>Datum</TableHead>
              <TableHead>Periode</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Totaal</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).map((n) => (
              <TableRow key={n.id}>
                <TableCell className="font-mono">{n.noteNumber}</TableCell>
                <TableCell>{n.issueDate}</TableCell>
                <TableCell className="text-muted-foreground">
                  {n.periodStart && n.periodEnd
                    ? `${n.periodStart} - ${n.periodEnd}`
                    : "—"}
                </TableCell>
                <TableCell>{n.status}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {eur.format(Number(n.total))}
                </TableCell>
                <TableCell className="text-right">
                  {!n.journalEntryId && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={post.isPending}
                      onClick={() => post.mutate({ id: n.id })}
                    >
                      Boeken
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {(data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  Nog geen onkostennota's.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      {creating && <CreateSheet onClose={() => setCreating(false)} />}
    </div>
  );
}
