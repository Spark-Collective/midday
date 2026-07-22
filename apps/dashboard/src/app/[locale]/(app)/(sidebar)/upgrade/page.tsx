import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Upgrade | Midday",
};

export default function UpgradePage() {
  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-200px)] md:py-6 md:-ml-8">
      <div className="w-full max-w-[640px] p-8 text-center">
        <h1 className="font-serif text-2xl text-foreground mb-4">
          Nothing to upgrade
        </h1>
        <p className="font-sans text-base text-muted-foreground leading-normal mb-2">
          This is a self-hosted Midday. All features are available — there are
          no plans, trials or charges.
        </p>
      </div>
    </div>
  );
}
