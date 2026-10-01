# Handoff #3: Expenses rebuild (phase 1 done 2026-10-01)

Read with `docs/HANDOFF.md` and `docs/HANDOFF-2026-09-30-payments-alerts.md`. Plan and design: `docs/EXPENSES-PLAN.md`. **No secrets in this file** (public repo).

## What exists now

- **Bank sync works.** The "Failed to send a request" error was stale deployed Plaid functions (old CORS origin). Redeployed; `plaid-*` are now `verify_jwt = false` in `supabase/config.toml` because they authenticate themselves.
- **"Last sync: never" bug:** `bank_items` had no read policy so the page never saw sync time or reconnect warnings. Migration 0046 grants the safe columns only (the `access_token` column is not readable from the browser).
- **Daily auto-sync:** pg_cron job `plaid-daily-sync` (12:00 UTC = 7am Chicago in summer) calls `plaid-sync` with header `x-cron-secret`. The secret is the Supabase function secret `SYNC_CRON_SECRET` and is embedded in the cron command (created by hand, **not** in any migration). To recreate: generate a new random value, `supabase secrets set SYNC_CRON_SECRET=...`, then `cron.unschedule('plaid-daily-sync')` and `cron.schedule(...)` with `net.http_post(url, headers {x-cron-secret}, body '{}')`. Run it by hand: `select command from cron.job where jobname='plaid-daily-sync'` then execute it.
- **No duplicates by design.** `expenses` = money events (only thing totals count). `expense_sources` = evidence with unique `(source_type, source_ref)`. One SQL function `find_expense_match()` (amount within tolerance 40 + same normalized vendor 40 + date proximity up to 20; the candidate must not already have evidence of the same type). Settings in `expense_settings` (window 5 days, tolerance $0). Vendor names normalize through `vendor_aliases` + `normalize_vendor()`.
  - Auto-link (amount + vendor + date): bank charge attaches to an existing manual/subscription expense.
  - Amount matches but vendor does not: new expense flagged `possible_duplicate` -> Review inbox (Merge or Keep both). Merge is reversible: `merge_expenses` / `unmerge_expense`, audited.
  - Two bank charges are never merged.
- **Bank rules** now have `action` (expense, transfer, owner_contribution, personal, payout) and `direction` (any/out/in). Only `expense` creates an expense. `bank_transactions.kind` records the classification. Zelle from the owner = owner contribution. Stripe deposit = payout (not income). Unknown deposits = `money_in`, held in Review.
- **Pending -> posted** charges are re-keyed (one row, one expense). Removed transactions archive bank-owned expenses and merely un-link adopted manual ones.
- **Stripe fees** become expenses per payment (`record_stripe_fee`, unique by payment intent, category "Payment processing fees"). The function tries the exact fee; the live restricted Stripe key can only write Checkout Sessions, so it falls back to the 2.9% + 30 cents estimate and says so in the note. **Owner action to make fees exact:** Stripe -> Developers -> API keys -> edit the restricted key -> set "Charges" (or "PaymentIntents") to Read. Estimates are replaced by exact values on the next call for that payment only; older estimates stay estimates.
- **UI:** Expenses has tabs All expenses / Review / Subscriptions / Bank feed. Evidence badges (🏦 📸 📧 💳 🔁 ✍️) on every row. Review inbox: possible duplicates (side by side), needs a category (remembers a rule), money in (classify). Bank feed shows "Last sync: X ago", an error banner, a Reconnect button when the login expires, and the Rules editor with actions.
- Integrity: `select expense_integrity();` (counts) and the nightly log table `expense_integrity_log`.

## Tests

- `supabase db query --linked -f supabase/tests/expense_dedup.sql`: runs inside a transaction that is **rolled back** (safe on live). Covers cases 1, 5, 8, 11, 12, 13 from the brief, merge/unmerge, idempotency, Stripe fee idempotency, evidence uniqueness, global invariants. Ends with `ALL EXPENSE DEDUP TESTS PASSED`.
- `npm test` (43 passing) and `npm run typecheck`.
- Idempotency proof: the real sync was run 3 times; the last two returned `added: 0` and totals did not change.

## Brief cases not covered yet (come with the receipts phase)

2 (receipt after bank), 3 (email + receipt + bank), 4 (same photo twice: file hash), 6 (split shipments, one-to-many), 7 (refunds reduce the original), 9 (cash receipt only). The schema and `find_expense_match(…, 'receipt')` already support them.

## Live data state (2026-10-01)

5 expenses: Anthropic $100 (monthly template), Court Solutions $10, Walmart $1.08, WebstaurantStore $66.51, Cloudflare $10.46. Two items in Review: Cloudflare and Court Solutions need a category; one $200 deposit needs classifying. The Anthropic $100 charge has not hit Chase yet; when it does it must link to the subscription (tested).

## Phase 3 mileage (done 2026-10-01)

- Migration `0049_mileage.sql`: `orders.delivery_miles` (saved by `create-order` from now on; older orders have none), `mileage_logs`, `irs_mileage_rates` (by DATE RANGE, because the 2026 rate changed on Jul 1: 72.5 cents Jan-Jun, 76 cents Jul-Dec, checked on irs.gov 2026-10-01, **unconfirmed until the owner taps Confirm**), `mileage_places`, `mileage_settings`, view `mileage_log_view` (prices each trip with the rate on its date; `counted` = live and not folded into a route).
- **Delivery trips are automatic**: when an order becomes `completed` (delivery, miles > 0, not a test name) a trip is created, round trip x2 (setting), unique per order forever (a trip the owner deleted never returns; cancelling retires only the system's own entry and restoring brings it back). Marked `estimated` because miles = straight line x 1.3, not an odometer; the UI shows an **Ask accountant** note.
- **Routes:** select 2+ same-day deliveries, enter the real total miles, they combine into one counted route (`combine_mileage_route` / `split_mileage_route`); no double counting.
- **One-tap supply trips** from saved places; `mileage-place` Edge Function (admin only) estimates one-way miles from the kitchen secrets, owner can overwrite.
- **Method:** standard vs actual with an "accountant confirmed" box; with standard, gas purchases (category "Gas / mileage") are flagged as not deductible on top.
- Mileage is a deduction, **never added into expense totals**. It is reported beside them (Tax Pack, phase 5).
- Tests: `supabase db query --linked -f supabase/tests/mileage.sql` (rolled back): rates by date, auto trip, idempotency, cancel/restore, owner-delete stays deleted, test/pickup/no-miles make no trip, one-way setting, route combine/split. Plus 5 vitest cases (48 total).
- Not verified against a real order yet: the first real completed delivery will prove `create-order` saves `delivery_miles` (the column and update are in place; the function still answers normally).

## Phase 5 tax-ready (done 2026-10-01)

Bookkeeping support for the accountant (Schedule C, sole proprietor). **Not tax advice:** the line mapping is a DRAFT and the UI says so; uncertain items say "Ask accountant".

- Migration `0051_tax_ready.sql`: `expense_categories.schedule_c_line / treatment (cogs, deductible, excluded) / always_ask / ask_note` (all 23 categories mapped; new categories Professional services, Phone & internet, Home office), `expenses.business_pct / ask_accountant / ask_note`, settings `business_start_date` (2026-10-01), `asset_threshold` ($500), `startup_limit` ($5,000 draft), view `expense_tax_view`, functions `tax_summary`, `tax_data_quality`, `tax_extras`.
- **Rules in the view:** deductible = total x business %; refunds and gas (when standard mileage is selected) deduct $0 with a flag; anything dated before the business start date goes to the **startup** bucket (not into the Schedule C lines); a single purchase >= the asset threshold is flagged "possible asset"; no category = "uncategorized". Recipe-based order cost (`auto_source = 'order_cost'`) is **excluded** so ingredients are not counted twice (real purchases are the cost of goods).
- **Tax tab** (Expenses): year picker (2026 = short first year), "Is it clean?" list (blocking vs warning), totals by Schedule C line, startup vs limit, mileage deduction, possible assets, Ask-accountant list (tap to open and fix), personal / owner money / Stripe payouts / transfers left out, editable category-to-line mapping and settings. Downloads: **Tax Pack PDF** (jsPDF, lazy-loaded; sections: data quality, lines, startup, mileage, assets, Ask accountant, left out), **Expenses CSV**, **Mileage CSV**. The PDF lists unresolved issues instead of hiding them.
- Expense form: **Business use %** and **Ask my accountant** (+ note). Bank/Stripe imported rows are now editable for category, business %, notes (date, vendor, amount are locked and refresh on sync).
- Tests: `supabase db query --linked -f supabase/tests/tax_pack.sql` (rolled back): lines, business %, standard-mileage gas exclusion (and actual method), refunds, startup bucket, asset threshold setting, order_cost excluded, archived rows excluded, data quality, extras. Plus 5 vitest cases (53 total).
- Owner decisions still open (all "Ask accountant"): startup election and limit, whether September expenses (Anthropic subscription etc.) are startup, standard vs actual mileage, estimated delivery miles, packaging as COGS vs supplies, equipment depreciation.

## Next

Not built: Phase 2 receipts (upload + SHA-256 dedupe, Gmail label inbox, Claude vision parsing with a key the owner pastes into Supabase, item splits, receipt matching) and Phase 4 food cost intelligence (needs the receipt line items from phase 2 as its data). Brief cases still open with phase 2: 2, 3, 4, 6, 7, 9.
