import type { Metadata } from "next";
import { ProposalView } from "@/components/proposal-view";

// A proposal link is private-by-obscurity and often still under negotiation, so
// it must never be indexed. Same posture as the customer portal.
export const metadata: Metadata = {
  title: "Proposal",
  robots: { index: false, follow: false },
};

type Props = { params: Promise<{ token: string }> };

export default async function ProposalPage({ params }: Props) {
  const { token } = await params;
  return <ProposalView token={token} />;
}
