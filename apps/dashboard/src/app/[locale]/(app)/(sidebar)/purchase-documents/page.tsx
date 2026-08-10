import type { Metadata } from "next";
import { PurchaseDocumentsContent } from "@/components/purchase-documents/purchase-documents-content";

export const metadata: Metadata = {
  title: "Aankoopdocumenten | Midday",
};

export default function PurchaseDocumentsPage() {
  return <PurchaseDocumentsContent />;
}
