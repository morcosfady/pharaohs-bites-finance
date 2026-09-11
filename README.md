# Pharaoh's Bites — Finance Dashboard

Private, owner-only financial management for the Pharaoh's Bites home food
business: orders captured automatically from the customer website, payments,
costs, recipe costing, profit, estimated Texas sales tax, delivery
profitability, reports, insights and exports.

| | |
| --- | --- |
| Dashboard (this repo) | https://morcosfady.github.io/pharaohs-bites-finance/ |
| Customer website | https://morcosfady.github.io/pharaohs-bites/ (repo `morcosfady/pharaohs-bites`) |
| Owner's guide | [OWNERS_GUIDE.md](OWNERS_GUIDE.md) |
| WhatsApp limits & Cloud API plan | [docs/WHATSAPP_CLOUD_API.md](docs/WHATSAPP_CLOUD_API.md) |

> All tax figures are **estimates** to help set money aside. They do not
> replace a tax professional or the Texas Comptroller.

---

## 1. Architecture

```
customer website (static, GitHub Pages)
   basket -> details -> [Complete Order on WhatsApp]
        |  POST {checkout_token, customer, items[slug, qty]}      (no prices)
        v
Supabase Edge Function  create-order        (service role, server-side only)
   validate -> re-price from products -> rate-limit -> intake_website_order()
        |  returns { ok, order_number }
        v
Postgres (Supabase)  orders / order_items / customers ... + RLS + audit triggers
        ^
        |  anon key + user JWT, every query filtered by is_admin()
finance dashboard (React + Vite, GitHub Pages)  <- Supabase Auth email/password
```

* **Frontend:** React 19, TypeScript, Vite, Tailwind CSS v4, Recharts,
  TanStack Query, react-router (HashRouter for GitHub Pages).
* **Backend:** Supabase Postgres, Auth, Storage (private `receipts` bucket),
  Realtime (new orders appear instantly), one Edge Function.
* **Money:** `numeric(12,2)` in the database; integer cents in the browser
  (`src/lib/money.ts`). Totals, tax and payment status are recomputed by
  database triggers, never trusted from the browser.
* **History:** order lines snapshot unit costs at sale time; ingredient and
  product cost history tables keep the trail. Financial rows are soft-deleted
  or voided; `audit_logs` records every change.

Repository layout:

```
src/                 app (pages/, components/, hooks/, lib/ pure calculations, test/)
supabase/migrations  0001 schema - 0002 RLS - 0003 catalogue - 0004 storage - 0005 intake
supabase/functions/create-order   public order intake (Deno)
supabase/seed.dev.sql             sample data, DEV ONLY
supabase/tests/rls_and_calculations.sql   database tests
.github/workflows/deploy.yml      test -> build -> GitHub Pages
```

## 2. Local installation

```bash
git clone https://github.com/morcosfady/pharaohs-bites-finance
cd pharaohs-bites-finance
npm ci
cp .env.example .env.local        # fill in VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run dev                       # http://localhost:5173
npm run demo                      # every screen with fixture data, no Supabase needed
npm test                          # vitest (calculations, message format, guard, table)
npm run typecheck && npm run build
```

### Environment variables (`.env.local`, never committed)

| Name | Meaning |
| --- | --- |
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | the **anon / public** key. Safe in the browser only because RLS is on. |
| `VITE_BUSINESS_WHATSAPP` | optional, digits only, default `17879684078` |

Never put the `service_role` key, the database password or any GitHub token in
`.env*`, in the repository, in the customer website or in CI variables that
end up in the bundle.

## 3. Supabase setup (one-time, about 15 minutes)

1. **Create a project** at https://supabase.com (region: US East is closest to
   Dallas). Note the *Project URL* and *anon public* key (Settings -> API).
2. **Apply the migrations** in order. Either:
   * install the CLI, `supabase login`, `supabase link --project-ref <ref>`,
     then `supabase db push`; or
   * open *SQL Editor* in the dashboard and run, one after the other:
     `supabase/migrations/0001_schema.sql`, `0002_rls.sql`, `0003_catalog.sql`,
     `0004_storage.sql`, `0005_intake.sql`.
3. **Disable public sign-ups:** Authentication -> Providers -> Email -> turn
   *Allow new users to sign up* **off**. (Also off in `supabase/config.toml`.)
4. **Create the first administrator:** Authentication -> Users -> *Add user* ->
   enter your email and a strong password (choose *Auto-confirm*). Copy the
   user's UUID, then in SQL Editor:
   ```sql
   insert into admin_profiles (user_id, full_name, role)
   values ('<paste the UUID>', 'Your Name', 'owner');
   ```
   Anyone not in this table sees "not an approved administrator" and the
   database returns nothing to them, even with a valid login.
5. **Deploy the Edge Function** (needs the CLI):
   ```bash
   supabase functions deploy create-order --no-verify-jwt
   ```
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to the function
   by Supabase automatically; nothing to paste. The function's allowed origins
   are listed at the top of `supabase/functions/create-order/index.ts`.
6. **Realtime:** Database -> Replication -> make sure `orders` is in the
   `supabase_realtime` publication (migration 0001 adds it).
7. **Confirm the tax settings:** the default rate is 8.25% (Dallas). Edit it,
   the filing frequency and next due date on the *Sales Tax* page.

### Row Level Security in one paragraph

Every table has RLS **enabled and forced**. The only policies are of the form
`using (is_admin())`, where `is_admin()` checks `admin_profiles` for the
calling user. The `anon` role has all table grants revoked. Admins cannot
`DELETE` orders, items, payments, refunds, expenses or audit rows; they void or
soft-delete via `UPDATE`. The website never talks to tables: it calls the Edge
Function, which uses the service role *inside Supabase* and only returns the
order number. Views run as `security_invoker`, so RLS applies to them too.
`supabase/tests/rls_and_calculations.sql` proves all of this on a dev
database (`psql "$DEV_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_and_calculations.sql`).

## 4. Customer-website integration

In the customer repo (`pharaohs-bites`), `assets/js/config.js`:

```js
financeOrderEndpoint: "https://<project-ref>.supabase.co/functions/v1/create-order",
financeAnonKey: "<anon public key>",
```

With these set, pressing **Complete Order on WhatsApp**:

1. disables the button ("Saving your order..."),
2. POSTs product ids, quantities and the customer's details with a
   per-basket `checkout_token` (idempotency key kept in `localStorage`),
3. on success stores the returned `PB-YYYY-NNNNN`, opens WhatsApp with the
   number in the message; a second click, a double-click or a refresh reuses
   the same token and number: **no duplicate orders**,
4. on failure shows a clear error and a *Try again* button; the basket and
   details are untouched.

Leaving `financeOrderEndpoint` empty keeps the original WhatsApp-only flow.

## 5. GitHub Pages deployment

`.github/workflows/deploy.yml` runs typecheck + tests, builds with the two
`VITE_` secrets, and publishes `dist/` to Pages on every push to `main`.

1. Repository -> Settings -> **Pages** -> Source: *GitHub Actions*.
2. Repository -> Settings -> **Secrets and variables -> Actions** -> add
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. Push to `main` (or *Run workflow*). Until the secrets exist the site
   deploys with a "Not connected to Supabase yet" notice on the login page.

### Custom domain (optional)
Add `public/CNAME` containing e.g. `finance.pharaohsbites.com`, create a CNAME
DNS record pointing to `morcosfady.github.io`, enable *Enforce HTTPS* in
Pages settings, and add the new origin to `site_url` in Supabase Auth.

## 6. Backup and restore

* **Quick:** dashboard -> Import / Export -> *Full backup (JSON)* (everything the
  owner can see; keep it private, it contains customer data).
* **Database-level:** Supabase -> Database -> Backups (daily on paid plans), or
  `supabase db dump -f backup.sql` with the CLI, or
  `pg_dump "$DB_URL" --no-owner --format=custom -f pb-$(date +%F).dump`.
* **Restore:** create a fresh project, run the migrations, then
  `pg_restore --data-only --no-owner -d "$NEW_DB_URL" pb-YYYY-MM-DD.dump`.
* **Receipts** live in the `receipts` storage bucket; download them from
  Storage in the dashboard or with `supabase storage cp`.

## 7. Sample data (development only)

`supabase/seed.dev.sql` inserts `[SAMPLE]`-tagged product costs, customers,
orders in every status, payments, a refund and expenses. It refuses to run if
real website orders exist. Use it only on a dev project:
`psql "$DEV_DB_URL" -f supabase/seed.dev.sql`. Production starts empty; use
*Import / Export* to bring in history.

## 8. Testing

* `npm test`: 38 unit/component tests: money maths, KPI formulas (discounts,
  refunds, tax excluded from revenue, cancelled orders, partial payments,
  labor toggle), product rankings, date presets/previous period, CSV
  round-trip and validation, WhatsApp message format and encoding, insights,
  login/unauthorized guard, responsive DataTable sorting/pagination.
* `supabase/tests/rls_and_calculations.sql`: anon and non-admin denial,
  server-side pricing, idempotent intake, unknown/inactive product rejection,
  discount/tax/total recomputation, payment-status derivation, refunds,
  status history, audit log, hard-delete prevention, sequential order numbers.
* Manual end-to-end (customer site with a stubbed endpoint): triple-click
  creates one order, refresh reuses it, basket change creates a new one,
  failure shows the retry, payload contains no prices.

## 9. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Login page says "Not connected to Supabase yet" | secrets/env missing at build time; add them and rebuild. |
| "This account is not an approved administrator" | insert the user into `admin_profiles`. |
| Website says "could not save order" | function not deployed, origin not in the allow-list, or migrations 0003/0005 missing. Check *Edge Functions -> Logs*. |
| Order appears but with $0 cost | add recipes / packaging on the product; costs are snapshotted at order time. |
| New orders don't appear until refresh | `orders` not in the realtime publication. |
| CI build fails on tests | run `npm test` locally; fixtures are in `src/test/fixtures.ts`. |

## 10. WhatsApp

An ordinary WhatsApp Business app cannot notify a website when a message
arrives. The first version therefore captures the order **before** WhatsApp
opens and shows it as *Pending WhatsApp Confirmation*; you confirm it by hand.
See [docs/WHATSAPP_CLOUD_API.md](docs/WHATSAPP_CLOUD_API.md) for what Meta's
Cloud API would require and where that code would go.
