/**
 * Seed the Belgian ledger for a team.
 *
 *   bun run src/scripts/seed-cli.ts <teamId> [--chart /path/to/chart.csv] [--years 2025,2026]
 *
 * Connects via DATABASE_URL (never defaults to production).
 */
import { Pool } from "pg";
import { seedBelgianLedger } from "../seed.js";

const [teamId, ...rest] = process.argv.slice(2);
const arg = (flag: string): string | undefined => {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
};

if (!teamId || !process.env.DATABASE_URL) {
  console.error(
    "usage: DATABASE_URL=postgres://... bun run src/scripts/seed-cli.ts <teamId> [--chart chart.csv] [--years 2025,2026]",
  );
  process.exit(2);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const result = await seedBelgianLedger(client, {
    teamId,
    chartCsvPath: arg("--chart"),
    years: arg("--years")?.split(",").map(Number),
  });
  await client.query("COMMIT");
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  client.release();
  await pool.end();
}
