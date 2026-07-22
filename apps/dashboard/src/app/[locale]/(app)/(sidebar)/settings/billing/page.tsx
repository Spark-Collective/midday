import { Card } from "@midday/ui/card";
import type { Metadata } from "next";
import { ManageSubscription } from "@/components/manage-subscription";
import { Orders } from "@/components/orders";
import { getQueryClient, prefetch, trpc } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Billing | Midday",
};

export default async function Billing() {
  const queryClient = getQueryClient();
  const user = await queryClient.fetchQuery(trpc.user.me.queryOptions());

  const team = user?.team;

  prefetch(
    trpc.billing.orders.infiniteQueryOptions(
      {
        pageSize: 15,
      },
      {
        getNextPageParam: ({ meta }) => meta?.cursor,
      },
    ),
  );

  return (
    <div className="space-y-12">
      {team?.plan !== "trial" && <ManageSubscription />}

      {team?.plan === "trial" && (
        <div>
          <h2 className="text-lg font-medium leading-none tracking-tight mb-4">
            Subscription
          </h2>

          <Card className="flex flex-col gap-2 p-4">
            <p className="text-sm font-medium">Self-hosted</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              This Midday instance is self-hosted by Spark Collective. There is
              no subscription and nothing will be charged.
            </p>
          </Card>
        </div>
      )}

      {(team?.plan !== "trial" || team?.canceledAt !== null) && <Orders />}
    </div>
  );
}
