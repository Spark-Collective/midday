import type { Metadata } from "next";
import { ExpenseNotesContent } from "@/components/expense-notes/expense-notes-content";

export const metadata: Metadata = {
  title: "Onkostennota's | Midday",
};

export default function ExpenseNotesPage() {
  return <ExpenseNotesContent />;
}
