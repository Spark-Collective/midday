"use client";

import { Icons } from "@midday/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { useFormContext } from "react-hook-form";
import { useInvoiceParams } from "@/hooks/use-invoice-params";
import { useTRPC } from "@/trpc/client";

/**
 * spark: say out loud what the submit button is about to do.
 *
 * "Create & Send" does two things on this self-host: it e-mails the PDF AND
 * files the invoice over Peppol as a structured e-invoice. Nothing in the UI
 * said so, so the Peppol leg was invisible until you went looking in the logs.
 *
 * The Peppol condition mirrors the worker exactly (see
 * apps/worker/src/processors/peppol/peppol-send-invoice.ts): a Belgian VAT
 * number becomes recipient `0208:<enterprise number>`, anything else is skipped.
 * If that rule ever changes, change it in both places.
 */

function peppolRecipient(vatNumber?: string | null): string | null {
  const vat = (vatNumber ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!vat.startsWith("BE")) return null;
  return `0208:${vat.slice(2)}`;
}

function Line({
  on,
  children,
}: {
  on: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2">
      <span
        className={`mt-[3px] shrink-0 ${on ? "text-primary" : "text-[#878787]"}`}
        aria-hidden="true"
      >
        {on ? (
          <Icons.Check className="size-3.5" />
        ) : (
          <Icons.Close className="size-3.5" />
        )}
      </span>
      <span className={on ? undefined : "text-[#878787]"}>{children}</span>
    </li>
  );
}

export function SendSummary() {
  const { watch } = useFormContext();
  const { selectedCustomerId } = useInvoiceParams();
  const trpc = useTRPC();

  const deliveryType = watch("template.deliveryType");
  const customerId = watch("customerId") ?? selectedCustomerId;
  const scheduledAt = watch("scheduledAt");

  const { data: customer } = useQuery(
    trpc.customers.getById.queryOptions(
      { id: customerId! },
      { enabled: !!customerId },
    ),
  );

  if (!customerId) return null;

  // Mirror the worker: `email` is the recipient and its absence skips the mail
  // entirely; `billingEmail` only ever rides along as a copy. Do not fall back
  // from one to the other, that would promise a mail that never goes out.
  const email = customer?.email ?? null;
  const ccCount = (customer?.billingEmail ?? []).length ?? 0;
  const recipient = peppolRecipient(customer?.vatNumber);

  if (deliveryType === "create") {
    return (
      <p className="text-xs text-[#878787]">
        Saved as a draft. Nothing is sent to the customer yet.
      </p>
    );
  }

  const when =
    deliveryType === "scheduled" && scheduledAt
      ? `On ${format(new Date(scheduledAt), "MMM d 'at' HH:mm")}`
      : deliveryType === "recurring"
        ? "On each run"
        : "On send";

  return (
    <div className="text-xs space-y-1.5">
      <p className="text-[#878787]">{when}:</p>
      <ul className="space-y-1">
        <Line on={!!email}>
          {email ? (
            <>
              E-mail with the PDF to <span className="font-medium">{email}</span>
              {ccCount > 0 ? `, copy to ${ccCount} billing address${ccCount > 1 ? "es" : ""}` : null}
            </>
          ) : (
            "No e-mail: this customer has no e-mail address, so nothing is sent"
          )}
        </Line>
        <Line on={!!recipient}>
          {recipient ? (
            <>
              E-invoice over Peppol to{" "}
              <span className="font-medium">{recipient}</span>
            </>
          ) : (
            "No Peppol: only customers with a Belgian VAT number are sent"
          )}
        </Line>
      </ul>
      {email && recipient ? (
        <p className="text-[#878787] pt-0.5">
          The customer receives it twice: once as a readable PDF, once as a
          structured e-invoice.
        </p>
      ) : null}
    </div>
  );
}
