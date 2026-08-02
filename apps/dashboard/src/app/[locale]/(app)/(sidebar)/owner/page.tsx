import type { Metadata } from "next";
import { OwnerContent } from "@/components/owner/owner-content";

export const metadata: Metadata = {
  title: "Owner | Midday",
};

export default function OwnerPage() {
  return <OwnerContent />;
}
