"use client";

import { Icons } from "@midday/ui/icons";
import { Skeleton } from "@midday/ui/skeleton";
import { useEffect, useState } from "react";

/**
 * spark: readable view for Peppol / UBL XML e-invoices.
 *
 * An inbound Peppol invoice is XML, not a PDF, so the PDF/image viewers render
 * nothing and the panel looks broken. Many senders do not embed a PDF rendition
 * either (`EmbeddedDocumentBinaryObject` is optional), so there is often no
 * document to show at all — the XML *is* the legal original. Parse it and show
 * the invoice instead.
 */

type Line = {
  name: string;
  qty: string | null;
  unitPrice: string | null;
  amount: string | null;
  vatPercent: string | null;
};

type Ubl = {
  id: string | null;
  issueDate: string | null;
  dueDate: string | null;
  currency: string;
  supplier: string | null;
  supplierVat: string | null;
  customer: string | null;
  customerVat: string | null;
  note: string | null;
  reference: string | null;
  lines: Line[];
  netAmount: string | null;
  vatAmount: string | null;
  totalAmount: string | null;
  embeddedPdf: string | null;
};

// UBL is namespaced (cbc:/cac:), so match on local names and ignore prefixes.
function local(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (const child of Array.from(el.children)) {
    if (child.localName === name) return child;
  }
  return null;
}

function text(el: Element | null | undefined, ...path: string[]): string | null {
  let cur: Element | null = el ?? null;
  for (const p of path) {
    if (!cur) return null;
    cur = local(cur, p);
  }
  const v = cur?.textContent?.trim();
  return v ? v : null;
}

function findAll(root: Element | Document, name: string): Element[] {
  return Array.from(root.getElementsByTagName("*")).filter(
    (e) => e.localName === name,
  );
}

function parseUbl(xml: string): Ubl | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  const root = doc.documentElement;
  if (!root) return null;

  const supplierParty = findAll(root, "AccountingSupplierParty")[0];
  const customerParty = findAll(root, "AccountingCustomerParty")[0];

  const partyName = (p?: Element) => {
    if (!p) return null;
    const party = local(p, "Party");
    return (
      text(party, "PartyLegalEntity", "RegistrationName") ??
      text(party, "PartyName", "Name")
    );
  };
  const partyVat = (p?: Element) => {
    if (!p) return null;
    const party = local(p, "Party");
    const scheme = party ? findAll(party, "CompanyID")[0] : null;
    return scheme?.textContent?.trim() ?? null;
  };

  const totals = findAll(root, "LegalMonetaryTotal")[0];
  const currency =
    text(root, "DocumentCurrencyCode") ??
    totals?.getAttribute("currencyID") ??
    "EUR";

  const lines: Line[] = findAll(root, "InvoiceLine")
    .concat(findAll(root, "CreditNoteLine"))
    .map((l) => {
      const item = local(l, "Item");
      const price = local(l, "Price");
      return {
        name:
          text(item, "Name") ??
          text(item, "Description") ??
          text(l, "Note") ??
          "—",
        qty:
          text(l, "InvoicedQuantity") ?? text(l, "CreditedQuantity") ?? null,
        unitPrice: text(price, "PriceAmount"),
        amount: text(l, "LineExtensionAmount"),
        vatPercent: item
          ? text(item, "ClassifiedTaxCategory", "Percent")
          : null,
      };
    });

  const attachment = findAll(root, "EmbeddedDocumentBinaryObject")[0];
  const embeddedPdf =
    attachment && (attachment.getAttribute("mimeCode") ?? "").includes("pdf")
      ? attachment.textContent?.trim() || null
      : null;

  return {
    id: text(root, "ID"),
    issueDate: text(root, "IssueDate"),
    dueDate: text(root, "DueDate"),
    currency,
    supplier: partyName(supplierParty),
    supplierVat: partyVat(supplierParty),
    customer: partyName(customerParty),
    customerVat: partyVat(customerParty),
    note: text(root, "Note"),
    reference: text(root, "BuyerReference"),
    lines,
    netAmount: text(totals, "TaxExclusiveAmount"),
    vatAmount: findAll(root, "TaxTotal")[0]
      ? text(findAll(root, "TaxTotal")[0]!, "TaxAmount")
      : null,
    totalAmount:
      text(totals, "PayableAmount") ?? text(totals, "TaxInclusiveAmount"),
    embeddedPdf,
  };
}

function money(v: string | null, currency: string) {
  if (!v) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(n);
  } catch {
    return `${v} ${currency}`;
  }
}

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-4 text-xs">
      <span className="text-[#878787]">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

export function UblViewer({ url }: { url: string }) {
  const [data, setData] = useState<Ubl | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.text();
      })
      .then((xml) => {
        if (cancelled) return;
        const parsed = parseUbl(xml);
        if (!parsed) {
          setState("error");
          return;
        }
        setData(parsed);
        setState("ok");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  if (state === "loading") return <Skeleton className="h-full w-full" />;

  if (state === "error" || !data) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Icons.BrokenImage className="size-8" />
          <p className="text-sm">Could not read this e-invoice</p>
        </div>
      </div>
    );
  }

  // The sender did include a PDF rendition: show the real document.
  if (data.embeddedPdf) {
    return (
      <iframe
        title="E-invoice"
        src={`data:application/pdf;base64,${data.embeddedPdf}`}
        className="h-full w-full"
      />
    );
  }

  return (
    <div className="h-full w-full overflow-auto bg-background p-4 text-sm">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="font-medium">{data.supplier ?? "Unknown supplier"}</p>
          {data.supplierVat && (
            <p className="text-xs text-[#878787]">{data.supplierVat}</p>
          )}
        </div>
        <span className="shrink-0 border px-2 py-0.5 text-[10px] uppercase tracking-wide text-[#878787]">
          Peppol e-invoice
        </span>
      </div>

      <div className="mb-4 space-y-1 border-t pt-3">
        <Row label="Invoice" value={data.id} />
        <Row label="Issued" value={data.issueDate} />
        <Row label="Due" value={data.dueDate} />
        <Row label="Bill to" value={data.customer} />
        <Row label="Reference" value={data.reference} />
      </div>

      {data.lines.length > 0 && (
        <div className="mb-4 border-t pt-3">
          {data.lines.map((line, i) => (
            <div
              key={`${line.name}-${i}`}
              className="flex justify-between gap-4 py-1 text-xs"
            >
              <span className="min-w-0 flex-1 truncate">
                {line.name}
                {line.qty ? (
                  <span className="text-[#878787]"> × {line.qty}</span>
                ) : null}
                {line.vatPercent ? (
                  <span className="text-[#878787]"> · {line.vatPercent}% VAT</span>
                ) : null}
              </span>
              <span className="shrink-0">
                {money(line.amount, data.currency)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1 border-t pt-3">
        <Row label="Net" value={money(data.netAmount, data.currency)} />
        <Row label="VAT" value={money(data.vatAmount, data.currency)} />
        <div className="flex justify-between gap-4 pt-1 text-xs font-medium">
          <span>Total</span>
          <span>{money(data.totalAmount, data.currency)}</span>
        </div>
      </div>

      {data.note && (
        <p className="mt-4 border-t pt-3 text-xs text-[#878787]">{data.note}</p>
      )}
    </div>
  );
}
