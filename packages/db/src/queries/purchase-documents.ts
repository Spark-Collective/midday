/**
 * Purchase document queries (M12). Header/lines are written as one unit and
 * the header totals are always the sum of the lines, never free-typed. A
 * credit note may link the invoice it credits either by id or by document
 * number (the Peppol BillingReference carries the number); posting enforces
 * the accounting guards, this layer only resolves references.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../client";
import { purchaseDocumentLines, purchaseDocuments } from "../schema";

export type PurchaseDocumentLineInput = {
  description: string;
  glAccountCode: string;
  /** Net amount, positive; the header's kind carries the direction. */
  amount: number;
  taxCode?: string | null;
  taxAmount?: number | null;
};

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type CreatePurchaseDocumentParams = {
  teamId: string;
  supplierName: string;
  supplierVat?: string | null;
  documentNumber: string;
  kind: "invoice" | "credit_note";
  /** Resolve the credited invoice by id, or by its document number. */
  creditsDocumentId?: string | null;
  creditsDocumentNumber?: string | null;
  issueDate: string;
  dueDate?: string | null;
  currency?: string;
  inboxId?: string | null;
  notes?: string | null;
  lines: PurchaseDocumentLineInput[];
};

export async function createPurchaseDocument(
  db: Database,
  params: CreatePurchaseDocumentParams,
) {
  if (params.lines.length === 0) {
    throw new Error("purchase document needs at least one line");
  }

  let creditsId = params.creditsDocumentId ?? null;
  if (!creditsId && params.creditsDocumentNumber) {
    const [ref] = await db
      .select({ id: purchaseDocuments.id })
      .from(purchaseDocuments)
      .where(
        and(
          eq(purchaseDocuments.teamId, params.teamId),
          eq(purchaseDocuments.documentNumber, params.creditsDocumentNumber),
          eq(purchaseDocuments.supplierName, params.supplierName),
        ),
      );
    if (!ref) {
      throw new Error(
        `no document ${params.creditsDocumentNumber} from ${params.supplierName} to credit`,
      );
    }
    creditsId = ref.id;
  }

  const taxTotal = r2(
    params.lines.reduce((s, l) => s + (l.taxAmount ?? 0), 0),
  );
  const total = r2(
    params.lines.reduce((s, l) => s + l.amount + (l.taxAmount ?? 0), 0),
  );

  return db.transaction(async (tx) => {
    const [doc] = await tx
      .insert(purchaseDocuments)
      .values({
        teamId: params.teamId,
        supplierName: params.supplierName,
        supplierVat: params.supplierVat ?? null,
        documentNumber: params.documentNumber,
        kind: params.kind,
        creditsDocumentId: creditsId,
        issueDate: params.issueDate,
        dueDate: params.dueDate ?? null,
        currency: params.currency ?? "EUR",
        amount: total,
        taxAmount: taxTotal,
        inboxId: params.inboxId ?? null,
        notes: params.notes ?? null,
      })
      .returning();

    await tx.insert(purchaseDocumentLines).values(
      params.lines.map((l, i) => ({
        purchaseDocumentId: doc!.id,
        teamId: params.teamId,
        position: i,
        description: l.description,
        glAccountCode: l.glAccountCode,
        amount: l.amount,
        taxCode: l.taxCode ?? null,
        taxAmount: l.taxAmount ?? 0,
      })),
    );
    return doc;
  });
}

export async function getPurchaseDocuments(
  db: Database,
  params: { teamId: string; status?: string; kind?: string },
) {
  const conditions = [eq(purchaseDocuments.teamId, params.teamId)];
  if (params.status)
    conditions.push(eq(purchaseDocuments.status, params.status));
  if (params.kind) conditions.push(eq(purchaseDocuments.kind, params.kind));
  return db
    .select()
    .from(purchaseDocuments)
    .where(and(...conditions))
    .orderBy(
      desc(purchaseDocuments.issueDate),
      desc(purchaseDocuments.createdAt),
    );
}

export async function getPurchaseDocumentById(
  db: Database,
  params: { teamId: string; id: string },
) {
  const [doc] = await db
    .select()
    .from(purchaseDocuments)
    .where(
      and(
        eq(purchaseDocuments.id, params.id),
        eq(purchaseDocuments.teamId, params.teamId),
      ),
    );
  if (!doc) return null;
  const lines = await db
    .select()
    .from(purchaseDocumentLines)
    .where(eq(purchaseDocumentLines.purchaseDocumentId, doc.id))
    .orderBy(purchaseDocumentLines.position);
  return { ...doc, lines };
}

export async function deletePurchaseDocument(
  db: Database,
  params: { teamId: string; id: string },
) {
  // The DB trigger refuses to delete a booked document; surface that as null.
  const [row] = await db
    .delete(purchaseDocuments)
    .where(
      and(
        eq(purchaseDocuments.id, params.id),
        eq(purchaseDocuments.teamId, params.teamId),
      ),
    )
    .returning();
  return row ?? null;
}
