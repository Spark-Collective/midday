import type { Metadata } from "next";
import { FilingsContent } from "@/components/filings/filings-content";

export const metadata: Metadata = {
  title: "Filings | Midday",
};

export default function FilingsPage() {
  return <FilingsContent />;
}
