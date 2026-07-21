import type { Metadata } from "next";
import { AccountingContent } from "@/components/accounting/accounting-content";

export const metadata: Metadata = {
  title: "Accounting | Midday",
};

export default function AccountingPage() {
  return <AccountingContent />;
}
