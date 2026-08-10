"use client";

import { Button } from "@midday/ui/button";
import { Input } from "@midday/ui/input";
import { Sheet, SheetContent, SheetHeader } from "@midday/ui/sheet";
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

/** Cost accounts incoming supplier documents realistically hit. */
const ACCOUNTS = [
  { code: "611010", label: "Computerbenodigdheden" },
  { code: "612300", label: "Software & hosting" },
  { code: "610800", label: "Onderhoud & herstellingen" },
  { code: "611901", label: "Brandstof/elektriciteit wagen" },
  { code: "612900", label: "Onthaalkosten" },
  { code: "616200", label: "Telefoon, GSM & internet" },
  { code: "613200", label: "Erelonen & vergoedingen" },
];

const TAX_CODES = [
  { code: "P21", label: "21% aftrekbaar" },
  { code: "P06", label: "6% aftrekbaar" },
  { code: "", label: "Geen btw" },
];

type DraftLine = {
  description: string;
  glAccountCode: string;
  amount: string;
  taxCode: string;
  taxAmount: string;
};

const emptyLine = (): DraftLine => ({
  description: "",
  glAccountCode: "611010",
  amount: "",
  taxCode: "P21",
  taxAmount: "",
});

const num = (s: string) => (s.trim() === "" ? 0 : Number(s));

function CreateSheet({ onClose }: { onClose: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [supplierName, setSupplierName] = useState("");
  const [supplierVat, setSupplierVat] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [kind, setKind] = useState<"invoice" | "credit_note">("invoice");
  const [creditsNumber, setCreditsNumber] = useState("");
  const [issueDate, setIssueDate] = useState(today);
  const [dueDate, setDueDate] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const trpc = useTRPC();
  const qc = useQueryClient();

  const create = useMutation(
    trpc.purchaseDocuments.create.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({
          queryKey: trpc.purchaseDocuments.list.queryKey(),
        });
        onClose();
      },
    }),
  );

  const total = lines.reduce((s, l) => s + num(l.amount) + num(l.taxAmount), 0);
  const set = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
        <SheetHeader className="mb-6">
          <h2 className="text-lg">
            {kind === "invoice" ? "Nieuwe aankoopfactuur" : "Nieuwe creditnota"}
          </h2>
          <p className="text-sm text-muted-foreground">
            Boeking: kosten en aftrekbare btw tegen leveranciers (440000). Een
            creditnota boekt exact gespiegeld.
          </p>
        </SheetHeader>

        <div className="mb-3 flex gap-2">
          <Button
            size="sm"
            variant={kind === "invoice" ? "default" : "outline"}
            onClick={() => setKind("invoice")}
          >
            Factuur
          </Button>
          <Button
            size="sm"
            variant={kind === "credit_note" ? "default" : "outline"}
            onClick={() => setKind("credit_note")}
          >
            Creditnota
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-muted-foreground">
            Leverancier
            <Input
              value={supplierName}
              onChange={(e) => setSupplierName(e.target.value)}
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Btw-nummer
            <Input
              value={supplierVat}
              placeholder="BE0..."
              onChange={(e) => setSupplierVat(e.target.value)}
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Documentnummer
            <Input
              value={documentNumber}
              onChange={(e) => setDocumentNumber(e.target.value)}
            />
          </label>
          {kind === "credit_note" && (
            <label className="text-xs text-muted-foreground">
              Crediteert factuurnummer
              <Input
                value={creditsNumber}
                placeholder="bv. 260807125"
                onChange={(e) => setCreditsNumber(e.target.value)}
              />
            </label>
          )}
          <label className="text-xs text-muted-foreground">
            Documentdatum
            <Input
              type="date"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Vervaldatum
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </label>
        </div>

        <div className="mt-6 space-y-3">
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-12 items-end gap-2 border-b pb-3">
              <label className="col-span-4 text-xs text-muted-foreground">
                Omschrijving
                <Input
                  value={l.description}
                  onChange={(e) => set(i, { description: e.target.value })}
                />
              </label>
              <label className="col-span-3 text-xs text-muted-foreground">
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
              <label className="col-span-2 text-xs text-muted-foreground">
                Netto
                <Input
                  inputMode="decimal"
                  value={l.amount}
                  onChange={(e) => set(i, { amount: e.target.value })}
                />
              </label>
              <label className="col-span-1 text-xs text-muted-foreground">
                Btw-code
                <select
                  className="h-9 w-full border bg-background px-2 text-sm"
                  value={l.taxCode}
                  onChange={(e) => set(i, { taxCode: e.target.value })}
                >
                  {TAX_CODES.map((t) => (
                    <option key={t.code} value={t.code}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="col-span-2 text-xs text-muted-foreground">
                Btw-bedrag
                <Input
                  inputMode="decimal"
                  value={l.taxAmount}
                  onChange={(e) => set(i, { taxAmount: e.target.value })}
                />
              </label>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLines((ls) => [...ls, emptyLine()])}
          >
            Lijn toevoegen
          </Button>
        </div>

        <div className="mt-6 flex items-center justify-between border-t pt-4">
          <span className="text-sm">
            Totaal{" "}
            <span className="font-mono tabular-nums">{eur.format(total)}</span>
          </span>
          <Button
            disabled={
              create.isPending || total <= 0 || !supplierName || !documentNumber
            }
            onClick={() =>
              create.mutate({
                supplierName,
                supplierVat: supplierVat || undefined,
                documentNumber,
                kind,
                creditsDocumentNumber:
                  kind === "credit_note" && creditsNumber
                    ? creditsNumber
                    : undefined,
                issueDate,
                dueDate: dueDate || undefined,
                lines: lines
                  .filter((l) => num(l.amount) > 0)
                  .map((l) => ({
                    description: l.description || "Aankoop",
                    glAccountCode: l.glAccountCode,
                    amount: num(l.amount),
                    taxCode: l.taxCode || undefined,
                    taxAmount: num(l.taxAmount) || undefined,
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

export function PurchaseDocumentsContent() {
  const [creating, setCreating] = useState(false);
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery(
    trpc.purchaseDocuments.list.queryOptions({}),
  );
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: trpc.purchaseDocuments.list.queryKey() });
  const post = useMutation(
    trpc.purchaseDocuments.post.mutationOptions({ onSuccess: invalidate }),
  );
  const remove = useMutation(
    trpc.purchaseDocuments.delete.mutationOptions({ onSuccess: invalidate }),
  );

  const numbersById = new Map(
    (data ?? []).map((d) => [d.id, d.documentNumber]),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg">Aankoopdocumenten</h1>
          <p className="text-sm text-muted-foreground">
            Leveranciersfacturen en creditnota's als open posten op 440000; een
            betaling (ook een nettobetaling na creditnota) wordt ertegen
            afgepunt.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>Nieuw document</Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Laden...</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Leverancier</TableHead>
              <TableHead>Nummer</TableHead>
              <TableHead>Soort</TableHead>
              <TableHead>Datum</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Bedrag</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).map((d) => (
              <TableRow key={d.id}>
                <TableCell>{d.supplierName}</TableCell>
                <TableCell className="font-mono">{d.documentNumber}</TableCell>
                <TableCell>
                  {d.kind === "credit_note" ? (
                    <span>
                      Creditnota
                      {d.creditsDocumentId && (
                        <span className="text-muted-foreground">
                          {" "}
                          op {numbersById.get(d.creditsDocumentId) ?? "?"}
                        </span>
                      )}
                    </span>
                  ) : (
                    "Factuur"
                  )}
                </TableCell>
                <TableCell>{d.issueDate}</TableCell>
                <TableCell>{d.status}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {d.kind === "credit_note" ? "-" : ""}
                  {eur.format(Number(d.amount))}
                </TableCell>
                <TableCell className="space-x-2 text-right">
                  {!d.journalEntryId && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={post.isPending}
                        onClick={() => post.mutate({ id: d.id })}
                      >
                        Boeken
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate({ id: d.id })}
                      >
                        Verwijderen
                      </Button>
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {(data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  Nog geen aankoopdocumenten.
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
