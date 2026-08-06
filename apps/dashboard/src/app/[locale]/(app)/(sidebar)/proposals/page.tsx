import type { Metadata } from "next";
import { ProposalsContent } from "@/components/proposals/proposals-content";

export const metadata: Metadata = {
  title: "Proposals | Midday",
};

export default function ProposalsPage() {
  return <ProposalsContent />;
}
