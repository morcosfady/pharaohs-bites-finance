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

## Phase 2 receipts (built 2026-10-01; AI reading waits for the owner's API key)

- Migration `0053_receipts.sql`: `receipt_files` (SHA-256 UNIQUE = the same photo twice is refused; Gmail Message-ID UNIQUE for emails), `apply_parsed_receipt()` (what the AI read -> expense), `item_category_memory` + `remember_item_category()`, `write_receipt_items()`, `find_refund_counterpart()`, `needs_receipt_view`, a rewritten `expense_tax_view` (**one row per category line**, `line_no` added) and `expense_integrity()` (partial coverage, receipts unmatched after 7 days, failed receipts). `normalize_vendor()` now also ignores words like credit/refund.
- **Matching** (SQL, one place): receipt/email -> existing expense when amount + vendor + date match (bank charge first, receipt first, subscription, earlier email); amount-only match -> new expense flagged possible duplicate; **many-to-one** (one bank charge, several receipts that add up) and **one-to-many** (one order email, several smaller card charges that add up, never overshooting the order) attach as partial evidence. Two bank charges are never merged.
- **Refunds:** a deposit from a store we bought from, or a refund email, reduces the ORIGINAL purchase and is never income. If both the email and the bank report the same refund it counts once (either order). Bank re-syncs never undo it.
- **Mixed carts:** items carry a category and a business/personal flag; the Expenses list shows one expense, the Tax view splits it by category (remainder stays on the expense's own category so lines always equal the total). Owner corrections are remembered per item name.
- **Edge Functions:** `receipt-parse` (admin; one file or all waiting), `receipt-email` (Gmail Apps Script, token `RECEIPT_INBOX_TOKEN`, deployed with `--no-verify-jwt`), shared `_shared/receiptSchema.ts` (prompt with vendor hints, strict JSON normalization, unit-tested in `src/test/receipt.test.ts`) and `_shared/receiptParse.ts` (Claude Messages API with image/PDF/text, model from `RECEIPT_MODEL`, default `claude-sonnet-5-5`).
- **Secrets:** `ANTHROPIC_API_KEY` (**owner pastes it in the Supabase website; not set yet**, receipts wait with status "Waiting for AI key" and are read when it is added: Receipts tab -> "Read N waiting"), `RECEIPT_INBOX_TOKEN` (generated, set; the filled-in Apps Script is at the owner's `Downloads\PB-Receipts-GmailScript.gs`, the repo copy `scripts/gmail-receipts.gs` has a placeholder).
- **UI:** Expenses -> Receipts tab (Take photo / Upload file, hash check before upload, big photos shrunk, gallery with status, detail with item categories, "Waiting for a receipt" list). Verified live at 320px; a real upload and the duplicate refusal were tested with a dummy image and cleaned up.
- **Tests:** `supabase db query --linked -f supabase/tests/receipts.sql` (rolled back): brief cases 1, 2, 3, 4, 6 (both directions), 7 (refund, double-reported refund both orders), 9, mixed cart split, personal item, items-not-adding-up, owner memory, unreadable total, medium-confidence duplicate, needs-a-receipt list, invariants. All four SQL suites + 64 vitest tests pass.
- **Not verified live yet:** the Claude reading itself (needs the key). First real receipt after the key is the proof; check the Receipts tab for "Check items" / "Needs attention".

## Forgotten costs (2026-10-01, migration 0054)

- **Stripe fee** is automatic per paid order (webhook) and now a **setting** (`expense_settings.stripe_fee_pct` 2.9 and `stripe_fee_fixed` 0.30, editable in Expenses -> Tax -> Tax settings). A daily job (`stripe-fee-backfill`, `backfill_stripe_fees()`) creates a fee for any paid Stripe order that has none (skips test names, deleted orders, voided payments). Estimates are replaced by exact fees when the Stripe key can read charges (owner: edit the restricted key, Charges = Read).
- New categories: Insurance (Line 15), Parking & tolls (Line 9, stays deductible with standard mileage), Postage & shipping, Rent / commissary (Line 20b, ask accountant).
- ~60 bank rules for common costs (software/hosting/domains/Plaid, bank fees, insurance, tolls, shipping, delivery apps, phone/internet, accounting, training, marketing, supplies). Owner income-tax payments (IRS USATAXPYMT) are classified personal. Unknown charges fall to "Other" and show under Ask accountant.
- Test: `supabase/tests/stripe_fees.sql` (rolled back). Costs the system cannot see on its own (cash, a new vendor) still need a receipt or a rule.

## Delivery profit (Menu & Profit -> Delivery tab, 2026-10-01)

Per delivery order: **paid** (delivery fee the customer paid) minus **gas** = profit. Gas = round-trip miles x `business_settings.default_mileage_cost_per_mile` (Settings, $0.67); a real cost typed on the order (`delivery_records.actual_cost`) replaces the estimate. Miles come from `orders.delivery_miles` (saved by `create-order` since phase 3), else `delivery_records.distance_miles`; an order with no miles is flagged "no miles saved" and gas is NOT guessed. Only confirmed/preparing/ready/out_for_delivery/completed orders count. Logic in `src/lib/deliveryProfit.ts` (9 vitest cases), UI `src/components/DeliveryProfit.tsx`. Separate from the IRS mileage deduction (Expenses -> Mileage), which uses the IRS rate. Verified with the demo build (sample data) at desktop and 320px; the live shop had no orders yet, so the live tab shows the empty state until the first delivery.

## Marketing tab (Expenses -> Marketing, 2026-10-01, migration 0055)

Marketing spend by **channel**: Social media, Flyers & print, Online ads, Email & website, Events & samples, Influencers & collabs, Other. `expenses.marketing_channel` (only for category "Marketing") is guessed from vendor + description by `marketing_keywords` (editable table; lowest sort wins; trigger `expenses_marketing_channel`), cleared if the expense leaves Marketing, and **never overwritten once the owner picks one** (per-charge dropdown on the tab, and a "Marketing channel" field in the expense form). More bank rules route Meta/TikTok/Vistaprint/FedEx Office (print, not shipping)/Mailchimp/Eventbrite etc. to Marketing. The tab shows spend with change vs the previous period, share of sales, marketing per order, biggest channel, a donut and a ranked channel list that expands into the charges, plus "Add marketing expense". Logic `src/lib/marketing.ts`, UI `src/components/MarketingTab.tsx`. Tests: `supabase/tests/marketing.sql` (rolled back) and 6 vitest cases. Live check: tab and form render, the data query returns 200; no real marketing spend exists yet so the live tab shows its empty state.

## Cost page removed (2026-10-01)

The owner asked to delete the top-level **Cost** page. It only listed the automatic recipe-cost entries (`auto_source = 'order_cost'`); those entries and the database trigger `sync_order_cost_expense` are untouched, so Menu & Profit, Home profit and the COGS numbers are unchanged. `/cost` now redirects to Home. To bring the page back: `git show 706e957:src/pages/Cost.tsx` (or any earlier commit) and re-add the route and nav item.

## Expense insights (2026-10-01, migration 0056)

- **Am I making money?** (top of All expenses): sales (net product sales + delivery revenue of confirmed/preparing/ready/out-for-delivery/completed orders in the period) minus expenses in the period. Cash view; Menu & Profit still shows per-dish profit.
- **Bills coming up:** `upcoming_bills(days)` walks every recurring template forward from its last generated charge (one source for the dashboard card and Telegram). Shows "keep aside" for 30 days and 7 days.
- **Monthly budgets:** `expense_budgets(category_id, monthly_limit)`, `budget_status(month)` (split-aware, from `expense_tax_view`). Green under 80%, amber from 80%, red from 100%. Set/edit/remove on the All expenses tab.
- **Trends tab:** stacked 12-month chart (top 5 categories + Everything else), top vendors for the chosen period with an average-charge-up flag, and **Ingredient prices** (from receipt line items: per lb / gal / each, same-store price change, cheaper-store tip; informs only, never changes dish costs). The ingredient list is empty until receipts are read (needs `ANTHROPIC_API_KEY`).
- **Weekly Telegram summary:** Edge Function `weekly-summary` (cron job `weekly-summary`, Mondays 13:00 UTC = 8am CDT / 7am CST, authenticated with `SYNC_CRON_SECRET`, created by copying the plaid-daily-sync command: it is not in a migration because it embeds the secret). Message = last Mon-Sun spent vs previous week, sales, left, top 3 categories, biggest charge, budgets >= 80%, ingredient price jumps >= 15% (same store, last 14 days, `ingredient_price_jumps()`), possible duplicates, charges without a receipt, receipts waiting, bills in the next 7 days. Manual run: `select command from cron.job where jobname='weekly-summary'` then execute it; add `"preview": true` to the body to return the text without sending.
- Tests: `supabase/tests/insights.sql` (rolled back) and 18 vitest cases (formatter, bills, budgets, trends, vendors, ingredient parsing). All 8 SQL suites and 105 vitest tests pass.

## Receipt threshold (2026-10-01, migration 0057)

The Tax tab warning "N expenses have no receipt on file" now counts only purchases at or above `expense_settings.receipt_min_amount` (default **$75**, the IRS line for documentary evidence; editable in Expenses -> Tax -> Tax settings, marked Ask accountant). Smaller charges still have the bank record as proof of payment. A split expense counts once. To satisfy the warning for a bigger purchase: open the expense and attach a photo/PDF (sets `receipt_path`), or upload it on the Receipts tab once the Claude key is set.

## Receipt prices -> dish costs (price book, 2026-10-01, migration 0058)

**Finding:** the live system has **0 ingredients and 0 recipes**; every dish cost is a flat number the owner typed (`products.ingredient_cost`). A dish switches to recipe-driven cost the moment it gets a recipe line (`recalc_product_cost`), so the owner must add ALL of a dish's ingredients first.

**What was built (Expenses -> Trends):** each Ingredient prices row has **+ Add to price book** (creates the `ingredients` row from the receipt, prefilled and editable, and a link in `ingredient_receipt_links(item_key, ingredient_id)`). The **Price book and dish costs** card compares each linked ingredient's package price with the latest receipt price (converted per lb / gallon / each into the package unit; refuses to compare cups vs pounds), shows **which dishes change and their margin before/after**, and **Apply new price** updates only `ingredients.package_price`. Nothing is ever applied automatically (owner rule: confirm price/cost changes). After Apply the existing triggers recalculate every dish using it and keep `ingredient_cost_history` and `product_cost_history`; dishes without a recipe keep their typed cost. Logic `src/lib/priceBook.ts` (mirrors `unit_to_base` / `recipe_line_cost`, 7 vitest cases), UI `src/components/PriceBook.tsx`. Test: `supabase/tests/price_book.sql` (rolled back). Empty until receipts are read (needs `ANTHROPIC_API_KEY`) and until recipes exist.

## Personal part of a purchase (2026-10-01, migration 0059)

A receipt can contain the owner's own things (e.g. ice cream in a Walmart order). `expenses.personal_amount` holds that part and `total_amount` shows ONLY the business money, so every total (Expenses, profit box, budgets, Telegram, tax pack) excludes it automatically. The bank charge still matches because matching, bank re-sync and the integrity check compare `total_amount + personal_amount` with the charge. The receipt's sales tax is spread over its items (`expense_items.tax_amount`), so a personal item carries its own share. Marking an item personal/business on the Receipts tab updates the expense by itself (trigger on `expense_items`). The tax view no longer has personal lines (they are simply not in the business total). Tests: new case in `supabase/tests/receipts.sql`.

## Receipts entered by hand from owner screenshots/PDFs (2026-10-01)

Until `ANTHROPIC_API_KEY` is set, receipts the owner sends are read by the assistant and entered through the same pipeline (`receipt_files` + `apply_parsed_receipt`, evidence type receipt, items kept): Walgreens flyer prints $12.96 (Marketing / Flyers & print), Amazon x8 ($151.85, another card), Walmart delivery order #2000154-94671986 ($94.69 business + $4.79 personal ice cream/tax), Costco Plano 9/12 butter $23.48, Ace Mart Restaurant Supply 9/12 $241.51 (new alias + bank rule "ACE MART"), plus a Walmart delivery subscription $10/month (recurring template, start date assumed Oct 1: owner to correct). Amazon item prices are as shown on the order pages (no tax shown); Amazon dates are delivery dates except the stickers (order date).

## Gallery tab and original receipt files (2026-10-01, migration 0060)

**Expenses -> Gallery:** the originals (photos and PDFs) of every receipt that has a picture, newest first, grouped by month, with search by store, month and photo/PDF filters; tap to enlarge, flip with the arrows (or keyboard), see every page of a multi-page receipt, download, open full size, or jump to the expense. Files live in the private `receipts` bucket (admin-only, short-lived signed links). `receipt_files.extra_paths` holds additional pages (main picture stays in `storage_path`). Logic `src/lib/gallery.ts` (4 vitest cases), UI `src/components/GalleryTab.tsx`.

**Originals uploaded 2026-10-01** (10 files, 8 MB, `originals/` in the bucket): Walgreens order, 5 Amazon order pages, Walmart order PDF, Costco photo, Ace Mart photos (2 pages). All 12 receipt rows now have their picture and every matching expense shows the paperclip. The Amazon list pages without prices were not stored. The upload used a throw-away Edge Function with a one-time token, deleted afterwards (the CLI cannot upload files and the browser pane blocks local files); to repeat: recreate a similar temporary function, or just use Receipts -> Upload file.

## Open items for a new session (2026-10-01, end of day)

1. Owner: add `ANTHROPIC_API_KEY` (Supabase secrets) so receipts are read automatically and ingredient prices fill in; then test with a real receipt.
2. Owner: Walmart subscription real billing day (template start date assumed 2026-10-01); screenshots of the hidden lists of Walmart order #2000152-76591017 (placeholder line of 36.48 to replace: re-run `apply_parsed_receipt` for that file, it is idempotent).
3. Accountant questions are listed in the Tax tab ("Ask accountant") and above in this file.
4. Possible next features: connect the other cards (Plaid) so Amazon/Ace Mart-type purchases are automatic; log supply-run mileage; Gmail script for order emails; exact Stripe fees.
5. How receipts are entered by hand, and the temporary upload-function method, are in the memory note `expenses-rebuild` (repeat the same way).

## Update (2026-10-01, later)

- Walmart #2000152 is now fully itemized (27 lines, the 36.48 placeholder was the ice cube tray 11.49 + paper bowls 24.99; lines 255.56 + tax 4.13 = 259.69). The 3 new screenshots are stored as pages p14-p16 (p13 in the bucket is an unlinked leftover).
- Walmart+ is a 30-day trial ($1 + tax, approx. Sep 27), renews Oct 27, 2026 at $98/year + tax unless cancelled. The $98 is NOT entered yet (owner may cancel).
- DBA filing done Sep 24: Collin County Clerk $18.50, Licenses and permits, with the picture in the Gallery. Oct 2 deadline is closed.
- The assistant uploads pictures itself (owner never uploads): temporary Edge Function, then delete it and unset its secret.

## Next

Phase 4 food cost intelligence is not built. It needs receipt line items (now stored in `expense_items`) to have data, so start it after some real receipts have been read.
