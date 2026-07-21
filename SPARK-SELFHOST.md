# Self-hosting the Spark Midday fork (Belgium edition)

A start-to-finish guide for standing up this fork of [Midday](https://midday.ai)
as a **self-hosted, Belgian-tailored business-operations system**, driven with
Claude Code. It is written as the runbook we wish we'd had: every step, and every
trap, in the order you hit them.

Upstream Midday is a hosted SaaS. It was never built to be self-hosted, and after
the Ramp acquisition (May 2026) it is unmaintained. This fork pins to a known-good
commit and adds what a self-host needs that upstream kept in its private
infrastructure (the "invisible infra": auth triggers, storage policies, DB
functions), plus Belgian primitives: **Ponto** (bank feed), **Recommand/Peppol**
(e-invoicing), EUR/VAT/KBO defaults.

> **Worked example throughout:** Spark Collective BV — box `midday-ops`, domains
> `ops.sparkcollective.be` (dashboard) + `ops-api.sparkcollective.be` (API),
> Supabase project `uzdlmwhvlzmjzkjcjgut`. Substitute your own.

---

## 0. What you get

```
  Invoices OUT ─▶ Midday ─▶ email (Resend) + Peppol (Recommand builds UBL)
  Invoices IN  ─▶ Peppol (Recommand) · email (Gmail connector) · manual upload
                     └─▶ inbox ─▶ OCR (Mistral→Google) ─▶ transaction matching
  Bank feed    ─▶ KBC + Revolut via Ponto (your Ibanity licence) ─▶ transactions
  Reconcile    ─▶ bidirectional matcher pairs invoices ↔ payments
```

All on one small box, one Postgres database, one git repo.

---

## 1. Prerequisites

| Thing | Why | Notes |
|---|---|---|
| **Supabase project** | Postgres + Auth + Storage | One project is enough. Note the ref, service key, JWT secret, and the **session pooler host** (see §3, gotcha). |
| **A small ARM/x86 VPS** | runs api + worker + dashboard + redis | Hetzner cax11 (ARM, ~€4/mo) is plenty. |
| **A domain + Cloudflare** | two subdomains, TLS | `ops.` (dashboard) and `ops-api.` (api). DNS-only (grey cloud) so Caddy can issue certs. |
| **Resend account** | transactional email (auth OTP + invoice send) | A verified sending domain, e.g. `mail.yourco.be`. |
| **1Password (or any vault)** | secrets, read just-in-time | Never bake secrets into images. |
| **Recommand account** | Peppol access point | Company registered + SMP. Gives `companyId`, API key/secret. |
| **Ibanity Ponto Connect app** | bank feed | Approved + certificates issued. See §7. |
| **A Mistral API key** | primary invoice OCR | Google Gemini is the fallback; set both. |
| **A Google Gemini API key** | OCR fallback + document classify/embed | `GOOGLE_GENERATIVE_AI_API_KEY`. |

Claude Code drives all of it; the human does the browser-only steps (OAuth
consents, portal clicks, DNS approvals).

---

## 2. The deploy model (build once, pull everywhere)

Building this monorepo needs ~10 GB of cache — do **not** build on the deploy box
(it will fill the disk). Instead:

1. GitHub Actions (`.github/workflows/spark-docker.yml`) builds `api`, `worker`
   (amd64+arm64) and `dashboard` (arm64, with `NEXT_PUBLIC_*` URLs baked in as
   build args) to GHCR.
2. A `publish-tars` job saves the arm64 images as `.tar.zst` assets on a rolling
   GitHub **release** (`images-main`). GHCR package visibility is a UI-only toggle;
   release assets need no auth, so the box pulls with plain HTTPS.
3. The box does: `curl` the tar → `zstd -d | docker load` → `docker compose up -d`.

```bash
# on the box, to (re)deploy after a CI run goes green:
cd /opt/midday
for app in api worker dashboard; do
  curl -sL -o /tmp/m.tar.zst https://github.com/<org>/midday/releases/download/images-main/midday-$app-arm64.tar.zst
  zstd -d -q -c /tmp/m.tar.zst | docker load && rm /tmp/m.tar.zst
done
docker compose -f compose.yml up -d
```

> The dashboard bakes `NEXT_PUBLIC_*` at **build** time. If you change the API URL
> or Supabase key, you must rebuild the dashboard image, not just restart it.

---

## 3. Database: apply the schema (the hard part)

Midday's schema lives in Drizzle (`packages/db`). Apply it to your project with
**`drizzle-kit export`** (emit SQL and run it), **never `drizzle-kit push`** —
push can drop tables it doesn't know about, and your project may hold other
schemas.

### 3.1 Prereqs before the DDL runs
```sql
create extension if not exists pg_trgm;
create extension if not exists btree_gin;
create schema if not exists private;
-- IMMUTABLE stubs: generated columns require them; upstream's test stubs omit it
create or replace function extract_product_names(...) returns text language sql immutable as $$ ... $$;
create or replace function generate_inbox_fts(...) returns tsvector language sql immutable as $$ ... $$;
```

### 3.2 Fixes to the exported SQL
- **Remove the fake `CREATE TABLE "auth.users"`.** Drizzle models the real
  `auth.users` as a literal-named table; its `users_pkey` collides with Supabase's.
  Delete that block and let FKs point at the real `auth.users`.
- **Strip btree opclass annotations.** The export stamps `text_ops` onto uuid
  columns → "text_ops does not accept uuid". Remove them.

### 3.3 The invisible infra (in NO upstream artifact — you must add it)
These lived in upstream's hosted dashboard and ship in no migration, docs, or test
bootstrap. Every one of them is a silent failure if missing:

| Object | Symptom if missing | Fix |
|---|---|---|
| **`handle_new_user()` + `on_auth_user_created` trigger** on `auth.users` | login "works" then bounces to /login forever (`user.me` finds no `public.users` row) | create the standard Supabase trigger (insert id/email/full_name/avatar_url, `on conflict do nothing`) + backfill existing auth users |
| **`private.get_teams_for_authenticated_user()`** | RLS + storage policies can't resolve team membership | `SECURITY DEFINER` over `users_on_team` returning `SETOF uuid` |
| **`generate_inbox(int)` + `nanoid(int)`** | team creation fails: unique-constraint violation, because the column default stored the LITERAL string `'generate_inbox(10)'` | create the functions, then `ALTER COLUMN ... SET DEFAULT public.generate_inbox(10)` (and `nanoid(24)` on `user_invites.code`) |
| **Storage RLS policies on `storage.objects`** | manual uploads spin forever (browser upload denied; only service-key uploads work) | per private bucket (vault/transactions/inbox/apps): authenticated user may CRUD where `(storage.foldername(name))[1]::uuid IN (SELECT private.get_teams_for_authenticated_user())`; public read on avatars/teams/users |

### 3.4 The casing gotcha (catches everyone)
Drizzle properties **without an explicit column name** (e.g. `baseAmount:
numericCasted(...)`) export as **camelCase** columns, but the runtime maps
snake_case (`casing: "snake_case"`). Result: `column "base_amount" does not exist`.
After applying, audit and rename:
```sql
-- must return ZERO rows:
select table_name, column_name from information_schema.columns
where table_schema='public' and column_name ~ '[A-Z]';
```
(We hit 6: `bank_accounts.available_balance/base_balance/credit_limit`,
`customers.billing_email`, `invoice_products.is_active`, `transactions.base_amount`.)

### 3.5 Audit for literal-string function defaults
```sql
select table_name, column_name, column_default from information_schema.columns
where table_schema='public' and column_default like '%''%(%';
```

---

## 4. Deploy: box, compose, env

### 4.1 Networking: host mode (on older kernels)
On some Debian 12 + Docker 29 boxes the bridge NAT is broken (SNAT counters tick
but packets never leave `eth0`), so containers can't reach the internet. Rather
than fight it, run `network_mode: host` and bind loopback ports that Caddy fronts.
Single-tenant box → the isolation tradeoff is fine.

### 4.2 Caddy (auto-TLS)
```
ops-api.yourco.be { reverse_proxy localhost:3003 }
ops.yourco.be     { reverse_proxy localhost:3001 }
```

### 4.3 The env file (`/opt/midday/.env.midday`, chmod 600) — critical values
| Var | Trap |
|---|---|
| `DATABASE_PRIMARY_URL` / `DATABASE_SESSION_POOLER` | use the **session pooler** `aws-1-eu-west-1.pooler.supabase.com` (region-specific — `aws-0` = "tenant not found"). NOT the direct `db.<ref>.supabase.co` host (IPv6-only, unreachable from containers). |
| `NODE_ENV=production` | dev mode disables DB SSL; Supabase requires it. |
| `API_INTERNAL_URL=http://127.0.0.1:3003` | under host networking. Wrong value (`http://api:8080`) makes the dashboard's server-side `user.me` fail → silent /login loop. |
| `INTERNAL_API_KEY` | any 32-byte hex. Worker's internal tRPC client crash-loops without it. |
| `FILE_KEY_SECRET` | any 32-byte hex. `user.me` derives a file key for users **with a team** and hard-throws without it → onboarding "breaks" login. **Keep it stable + back it up** (file keys derive from it). |
| `MIDDAY_ENCRYPTION_KEY` | 32-byte. Encrypts stored OAuth tokens (inbox/bank). Keep stable. |
| `INVOICE_JWT_SECRET` | signs invoice share links. |
| `SLACK_ENCRYPTION_KEY` | must decode to exactly 32 bytes (real 64-hex), even if you don't use Slack — t3-env validates it at boot. |
| `MISTRAL_API_KEY` + `GOOGLE_GENERATIVE_AI_API_KEY` | OCR primary + fallback / classify / embed. Without them, inbox docs stay "Analyzing". |
| Dashboard build arg `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | use the real **publishable key** (`sb_publishable_…`, from management API `/api-keys?reveal=true`). A hand-minted legacy JWT anon key gives `401 Invalid API key`. |

---

## 5. Auth email (Resend) — why first login fails silently

Supabase's **built-in** mailer only delivers to project-team members, caps at
2/hour, and lands in spam. First-login OTPs just vanish. Fix: **custom SMTP →
Resend**.

1. Verify a sending subdomain in Resend (e.g. `mail.yourco.be`): add its
   DKIM/SPF/MX to DNS. Use a dedicated subdomain so your root-domain mail
   (Gmail/Workspace) is untouched.
2. Point Supabase Auth at `smtp.resend.com:465`, user `resend`, pass = Resend key,
   sender `midday@mail.yourco.be`. Set `site_url=https://ops.yourco.be` and the
   redirect allow-list.

**Two more auth traps:**
- **OTP length.** Midday's form has 6 boxes and auto-submits at 6. If the project's
  `mailer_otp_length` is 8 (a Supabase default), **every** code is impossible to
  enter. Set it to 6.
- **Templates.** Stock Supabase templates send a confirm **link** that dead-ends
  (no code-exchange route). Patch the `magic_link` + `confirmation` templates to
  show the `{{ .Token }}` code. (This fork also disables upstream's shutdown
  waitlist gate, which otherwise signs out every user created after 2026-04-20.)

---

## 6. First login → team → onboarding

Log in at `ops.yourco.be` (email → 6-digit code). Complete the profile, then
create the team (base currency **EUR**, country **BE**). If team creation errors,
you skipped §3.3 (`generate_inbox`). If login loops after onboarding, you skipped
`FILE_KEY_SECRET` (§4.3) or the users trigger (§3.3).

---

## 7. Belgian bank feed (Ponto / Ibanity)

This fork ships a native `ponto` banking provider
(`packages/banking/src/providers/ponto`) alongside gocardless/plaid/teller/
enablebanking.

**One-time Ibanity setup (browser + CLI):**
- App approved in the Ibanity portal; submit **CSRs whose subject exactly matches
  the portal's** (CN + serialNumber from the cert dialog) — pre-generated CSRs are
  rejected as "invalid". Regenerate from your existing keys with `-subj` copied
  from the portal.
- `client_id`/`client_secret` **rotate on activation** — take them from the portal
  Security tab, not old notes.
- The user-facing consent endpoint is `authorization.myponto.com/oauth2/auth`
  (no mTLS, browser-reachable); only `api.ibanity.com` needs the client cert.
  Register redirect `https://localhost:7853/callback` (portal refuses http). No
  local server needed — the browser dead-ends with the `?code=` in the address bar.

**Env on the box:** `PONTO_CLIENT_ID/SECRET`, `PONTO_MTLS_CERT/KEY` (PEMs
single-lined with literal `\n`).

**Connect + sync:** seed a `bank_connections` row (provider `ponto`,
`access_token` = the Ponto **refresh** token) and `bank_accounts` rows. The
provider mints access tokens from the refresh token and **persists Ory rotations
back to the row** — token custody lives in the DB, not the vault. A worker
`bank-sync-scheduler` (every 4h) refreshes balances + pulls transactions and
chains enrichment. **PSD2 reauth every ~90 days** — schedule a reminder.

---

## 8. E-invoicing (Recommand / Peppol)

`apps/worker/src/utils/recommand.ts` + two processors:

- **Inbound** (`peppol-inbox-scheduler`, hourly): pulls incoming Recommand
  documents (embedded PDF, else UBL XML) → vault → `process-attachment` → OCR →
  matching. Dedupe by `inbox.reference_id = peppol_<docId>`.
- **Outbound** (`peppol-send-invoice`, enqueued by the invoice send flow): maps a
  Midday invoice to Recommand structured JSON (`{recipient: 0208:<KBO>,
  documentType, document}`; Recommand builds the UBL). Skips customers with no
  Belgian enterprise number. The operator's "Create & Send" is the approval.

**Env:** `RECOMMAND_API_KEY/SECRET`, `PEPPOL_COMPANY_ID`.

---

## 9. Email inbox (Gmail connector)

Forwarded invoices flow in via Midday's built-in Gmail connector.

- Reuse an **existing Google OAuth client** if you have one. A *desktop* client
  (loopback redirect) can't drive Midday's connect button, but you don't need the
  button: run consent out-of-band (localhost redirect, same as Ponto), then seed
  the `inbox_accounts` row directly.
- **Tokens are stored AES-256-GCM encrypted** (`MIDDAY_ENCRYPTION_KEY`). Seeding
  plaintext → decrypt fails "Unsupported state". Encrypt with the in-container
  `encrypt()` before storing.
- Trigger a manual sync: job `sync-scheduler` on queue `inbox-provider`, payload
  `{ id, manualSync: true }` (the key is `id`, not `inboxAccountId`).
- Point a group/alias (e.g. `invoice@yourco.be`) at the connected mailbox.

---

## 10. Invoicing polish (branding)

- Upload the logo to the `avatars` bucket; set `teams.logo_url`. Use the **symbol/
  mark alone** for the sidebar (the team name renders as text beside it — a full
  wordmark is redundant and cramped). Keep the **full wordmark** on invoice PDFs
  (`invoice_templates.logo_url` / each invoice's `template.logoUrl`) where a
  letterhead wants it.
- Seed a default `invoice_templates` row: EUR, A4, `dd/MM/yyyy`, VAT enabled, your
  address block + KBO/VAT in `from_details`, IBAN in `payment_details`. Every new
  invoice then starts branded and pre-filled.
- Regenerate a PDF: enqueue `generate-invoice` on the `invoices` queue with
  `{ invoiceId, deliveryType: "create" }`.

---

## 11. Worker jobs (BullMQ) cheat-sheet

Upstream ran background work on Trigger.dev; this fork runs BullMQ in the worker.
Enqueue from inside the worker container (`docker exec … bun -e`), on `redis
127.0.0.1:6379`:

| Job | Queue | Payload |
|---|---|---|
| `bank-sync-scheduler` | `transactions` | `{ manualSync?: bool }` |
| `enrich-transactions` | `transactions` | `{ transactionIds: string[], teamId }` (batch **≤10** — one bad row fails the whole batch) |
| `sync-scheduler` (email inbox) | `inbox-provider` | `{ id, manualSync?: bool }` |
| `process-attachment` | `inbox` | `{ filePath, mimetype, size, teamId, referenceId }` |
| `peppol-inbox-scheduler` | `inbox` | `{}` |
| `peppol-send-invoice` | `invoices` | `{ invoiceId }` |
| `generate-invoice` | `invoices` | `{ invoiceId, deliveryType }` |

---

## 12. Gotcha index (fastest path when something breaks)

| Symptom | Cause | Section |
|---|---|---|
| First-login OTP never arrives | no custom SMTP (built-in mailer) | §5 |
| Every OTP rejected | `mailer_otp_length: 8` vs 6-box form | §5 |
| Email is a link that dead-ends | stock templates not patched | §5 |
| Login succeeds then loops to /login | missing users trigger, or `FILE_KEY_SECRET`, or wrong `API_INTERNAL_URL` | §3.3 / §4.3 |
| `401 Invalid API key` in dashboard | built with a minted legacy anon key | §4.3 |
| Team creation fails (unique violation) | `generate_inbox`/`nanoid` literal defaults | §3.3 |
| `column "base_amount" does not exist` | camelCase export vs snake_case runtime | §3.4 |
| Manual upload spins forever ("File not found") | no `storage.objects` RLS policies | §3.3 |
| Inbox docs stuck "Analyzing" | missing `MISTRAL_API_KEY`/`GOOGLE_…` or enrichment never enqueued | §4.3 |
| Invoice share link fails | placeholder token, not signed with `INVOICE_JWT_SECRET` | §10 |
| Ponto `invalidClientId`/`invalid_client` | creds rotated at activation | §7 |
| Ponto browser `ERR_BAD_SSL_CLIENT_AUTH_CERT` | hit `api.ibanity.com` instead of `authorization.myponto.com` | §7 |
| `op` hangs for minutes | the `op` caching daemon wedged — `OP_CACHE=false`, or `pkill -f "op daemon"` | — |

---

*Pin the fork; don't chase upstream (it's unmaintained). Mark your changes
(`fix(spark)` / `feat(spark)`) so the diff vs upstream stays greppable. AGPL: keep
the fork source public.*
