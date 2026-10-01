# Pharaoh's Bites: handoff #2 (online payment, delivery fee, alerts, receipts, cleanup)

**Written:** 2026-09-30 (end of a very long session). **Read this together with** `docs/HANDOFF.md` (written 2026-09-29), which still describes the base architecture, the domains/DNS, the content rules and the runbooks. This file covers **everything that changed after it**. Where the two disagree, **this file wins**.

> ⚠️ **Both repos are PUBLIC.** This file deliberately contains **no secrets and no personal data** (no keys, tokens, EIN/SSN, legal name, date of birth, bank details). Those live in Supabase secrets, Stripe, and the owner's private Gmail ("Pharaoh's Bites - Business Registration Info"). **Never commit them.**

---

## 0. TL;DR (what the system does now)

1. A customer builds an order on **pharaohsbites.com/order.html**, types name, phone, **email (required)**, street address, picks a delivery date + time window.
2. The page shows the **delivery fee live** ($5 + $1.75 per mile) and the **total before paying**.
3. **Place Order & Pay** → order saved as *Pending* → customer pays by **card on Stripe Checkout (live mode)**.
4. When Stripe confirms the payment: order becomes **Paid + Confirmed**, the owner gets a **Telegram alert** (English + Arabic dish names), the customer gets a **styled email receipt**, and the customer sees "Payment received ✅" (WhatsApp is now only an **optional** extra).
5. **Pickup was built but is hidden** (delivery only for now). One switch brings it back (section 6).
6. All test data was removed from the dashboard on 2026-09-30 (soft delete). **The next real order is the first real one.**

Owner preferences are unchanged (section 12): short replies, non-technical, Franglais/Egyptian Arabic in Latin letters.

---

## 1. Systems and where things live (additions)

| Thing | Where |
|---|---|
| Customer website (static) | repo `morcosfady/pharaohs-bites`, local `F:\Portfolio\Nile Bites`, https://pharaohsbites.com |
| Dashboard (React/Vite) + Supabase code | repo `morcosfady/pharaohs-bites-finance`, local `F:\Portfolio\pharaohs-bites-finance`, https://finance.pharaohsbites.com |
| Backend | Supabase project ref `vvwunhcpxofvnjijemdb` |
| Payments | **Stripe LIVE account** `acct_1ULAslPMJG0y1uZI` ("pharaohs bites"). A separate **sandbox** account also exists (`acct_1ULAVBPD0aIuDaXl`), only used for the first tests |
| Live webhook | Stripe → Workbench → Webhooks → destination **pharaohs-bites-payments-live** (`we_1ULTYlPMJG0y1uZIlQE2nELr`), event `checkout.session.completed`, URL `https://vvwunhcpxofvnjijemdb.supabase.co/functions/v1/stripe-webhook` |
| Owner alerts | **Telegram bot** `@pharaohsbites_orders_bot` (BotFather), plus **ntfy** as a weak backup |
| Customer receipts | Existing **Google Apps Script** mail relay (business Gmail), new private `receipt` path |
| Delivery distance | US Census geocoder (free, no key) + straight-line × 1.3 |

Business facts: Dallas cloud kitchen, delivery only (for now), service area all DFW, WhatsApp-only phone +1 (787) 968-4078, business email pharaohsbites.dallas@gmail.com. **Business name spelling for legal/registration fields: "Pharaohs Bites" (no apostrophe).** The website brand text uses "Pharaoh's Bites". Stripe's public name was set to "Pharaoh's Bites" (owner may want it changed to match records).

---

## 2. Edge Functions (all in `supabase/functions/`)

All deployed with `supabase functions deploy <name> --no-verify-jwt --project-ref vvwunhcpxofvnjijemdb` (config in `supabase/config.toml`).

| Function | Purpose |
|---|---|
| `create-order` | Public order intake. Validates, re-prices from DB, computes delivery fee (or $0 for pickup), saves via RPC `intake_website_order`, sets `delivery_fee`/`delivery_method`/`status`, then either **notifies immediately** (non-paying orders) or **parks the notification** in `orders.notify_payload` (pay-online orders). Requires **valid email**, delivery date tomorrow+ (Chicago). |
| `delivery-quote` | Public, read-only price quote for an address (used live on the order page). Returns `{ok, delivery_fee, miles}`. |
| `create-checkout` | Public. Actions `create` (builds the Stripe Checkout Session for the **DB balance**, never the browser total) and `status` (is it paid? + **safety net**: if the webhook is late it asks Stripe directly and records the payment itself). Returns pickup address only to paid pickup orders. |
| `stripe-webhook` | Verifies the Stripe signature (HMAC, 5 min tolerance) and calls `recordPaidSession`. |
| `plaid-*` | Unchanged, bank feed, not in active use. |
| `_shared/notify.ts` | `notifyAll()`: Telegram alert (HTML, quote-block delivery time, Arabic names, total items), ntfy backup, customer email receipt (`receiptHtml`). Also `AR_NAMES` (slug → Arabic name, mirrors the website menu). |
| `_shared/payments.ts` | `recordPaidSession()`: inserts the payment (unique `stripe:*` reference), sets method card, **confirms the order and sends the alert + receipt exactly once** (via `notify_payload`). |
| `_shared/delivery.ts` | `quoteDelivery()`: the fee formula + geocoder. **One place to change pricing.** |

### Delivery fee formula
`fee = round(5 + 1.75 × miles, 2)` where `miles = straight-line distance × 1.3` (approximate road miles). Kitchen coordinates are in secrets (`KITCHEN_LAT`, `KITCHEN_LON`), **not in the repo**. Google Maps (driving distance) was attempted; the owner's Google Cloud billing was refused (`OR_BACR2_59`), so the free straight-line method is used. A downtown address came to about 19.8 miles = $39.65. Tax is **not** charged yet (owner will ask the accountant; `tax_status = 'review'` on items).

### Order status logic (important)
- **Pay-online order:** created as `pending_whatsapp_confirmation` (label now just **"Pending"**), `notify_payload` filled. Stripe confirms → `confirmed`, payload cleared, alert + receipt sent. If the customer abandons payment, the order stays Pending and the owner is **not** alerted.
- **Non-paying path** (only if the website's `financeCheckoutEndpoint` is empty): created `confirmed`, notifications sent immediately.

---

## 3. Database changes (migrations in `supabase/migrations/`, also appended to `ALL_MIGRATIONS.sql`)

- `0040_stripe_payments.sql`: `orders.stripe_session_id`; unique index `payments_stripe_ref_uniq` on `payments(reference)` for `stripe:%` rows (webhook retries can never double-record).
- `0041_test_item.sql`: **temporary** 1-cent drink for payment testing.
- `0042_notify_payload.sql`: `orders.notify_payload jsonb` (parked notification details for pay-online orders).
- `0043_remove_test_item.sql`: removes the test item.

Apply a migration with `supabase db query --linked -f supabase/migrations/00NN_name.sql` (**never `db push`**, history is out of order). Verify with `supabase db query --linked "select ..."`.

**Cleanup done 2026-09-30:** all orders soft-deleted, all payments voided, all 6 test customers soft-deleted, `order_intake_log` cleared, test item deactivated. What remains live: **0 orders, 0 payments, 0 customers, 2 expenses ($110: Anthropic $100 operating + Court Solutions $10 bank-feed import), 23 products**. The auto "Kitchen" cost expenses linked to test orders were archived automatically by the existing trigger (`sync_order_cost_expense`). Order numbering continues (next is ~PB-2026-00131).

---

## 4. Website changes (repo `pharaohs-bites`)

Current asset versions (bump `?v=` in **every** HTML when editing): `main.js?v=106`, `config.js?v=106`, `pages.css?v=122`, `data.js?v=102`.

**`order.html` / `assets/js/main.js` / `assets/js/config.js` / `assets/css/pages.css`:**
- Button is now **"Place Order & Pay"**, gold pharaonic style (`.btn--place`, shimmer). No WhatsApp wording anywhere in the checkout (owner did not want customers to think WhatsApp is required). The "add sides / desserts" nudge buttons say "Place order"/"Continue to payment".
- **Email is required**; phone and email validated (`FIELD_RULES`, `readCustomer()`). Bug fixed during the session: the email was added to the wrong list and the button never unlocked. Both lists (`REQUIRED_FIELDS` and the `readCustomer` array) must contain `email`.
- **Missing-field alerts:** the button is no longer `disabled`; it uses `aria-disabled` + `.is-disabled`. Tapping it calls `reportMissing()` → message "Please complete: email, delivery time window." + scroll/focus the first missing field + inline errors. Clears itself when fixed.
- **Live fee + total:** basket shows Subtotal / Delivery (X mi) / Total. `refreshQuote()` calls `financeQuoteEndpoint` (debounced) when the address is valid. States: idle ("enter your address"), calculating, ok, error.
- **Delivery/Pickup choice:** `fieldset.fulfil` with radios `fulfillment`. **Hidden by `enablePickup: false` in `config.js`**. With it on: pickup hides the address fields, fee $0, labels switch to "Pickup", `config.pickupAddress` is shown in a gold box, and the payload sends `fulfillment: "pickup"`. **To re-enable: set `enablePickup: true`, bump `?v=`, push.** Server side is already deployed and tested (a real pickup order saved correctly: `delivery_method = pickup`, fee 0).
- **Online payment is ON:** `financeCheckoutEndpoint` is set in `config.js`. Flow in `submitOrder → recordOrder (pay_online:true) → startPayment → redirect to Stripe`. Return page `order.html?paid=1&order=PB-…` runs `initPaidReturn()` which polls `status` and shows **"Payment received ✅"** with **Done** and an optional **"Also send on WhatsApp (optional)"**. Cancel returns `?cancelled=1` with a friendly message.
- Pickup-mode post-payment message includes the pickup address (from `create-checkout` status).
- **Site wording is delivery-only** on index/about/contact/catering/order, including meta descriptions and structured data.
- `data.js`: temporary test item added then **removed** (23 real dishes).
- To go back to WhatsApp-only ordering (kill switch): set `financeCheckoutEndpoint: ""` in `config.js` and bump the version.

**Receipts/alerts details**
- Email receipt is HTML dark/gold, includes order no., items, dishes subtotal, delivery fee, total, delivery date + window, address. Skipped for `@example.com` addresses (used in tests).
- Telegram message layout: bell + order no.; **quote block** with "DELIVER ON / date (bold, underlined) / window (monospace)"; customer block; items with unit totals and Arabic names; Dishes / Delivery / TOTAL; **Total items: N**.

---

## 5. Secrets (NAMES only; values are in Supabase → Edge Functions → Secrets)

`STRIPE_SECRET_KEY` (live **restricted** key, permission Checkout Sessions: Write), `STRIPE_WEBHOOK_SECRET` (whsec of the live webhook), `KITCHEN_LAT`, `KITCHEN_LON`, `KITCHEN_ADDRESS` (pickup address text), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `NTFY_TOPIC`, `NTFY_TOKEN`, `RECEIPT_URL`, `RECEIPT_TOKEN` (Apps Script receipt path), plus the older `PLAID_*`. `NOTIFY_DEBUG` was used temporarily and is unset.

**Security TODO (recommended):** several of these values were pasted into the chat during setup (live restricted key, webhook secret, Telegram bot token, ntfy token, the receipt/enquiry tokens were also visible earlier). Rotate them when convenient: Stripe key (Developers → API keys → Rotate), webhook secret (Roll), BotFather `/revoke`, ntfy token. After rotating, **re-save via the Supabase website** (see gotchas).

---

## 6. Stripe account status (as of 2026-09-30)

- Live account **active for payments**. Tasks cleared: representative identity, bank account added. **Tax ID task "in review"** (the EIN was issued 2026-09-23 and can take up to ~2 weeks to reach IRS records; payouts get paused around $600 or Oct 30 until it clears). The EIN belongs to the individual who owns the sole proprietorship (DBA "Pharaohs Bites"); Stripe's legal-name field must match the IRS record exactly. Details are in the owner's private email, **not here**.
- **First payout** typically 7 to 14 days after the first payment, then ~2 business days. The owner asked why the test money did not hit the bank: that is normal.
- **Minimum card charge is $0.50.** A pickup order of a few cents fails with "amount too small". Delivery adds $5 so it is fine.
- Fees ≈ 2.9% + 30¢ per card payment.
- **Owner TODO:** refund the live test payments **PB-2026-00129 ($2.50)** and **PB-2026-00130 ($2.50)** in Stripe (Payments → payment → Refund). The first test payment ($8.00, PB-2026-00105) was in the **sandbox** (no real money). Refunds are the owner's action (money movement).
- Customer-facing statement descriptor: "PHARAOHS BITES". Radar Lite (free) on. Stripe tax and climate features off.

---

## 7. Hard-won gotchas (do not repeat these)

1. **The chat UI masks secret-looking strings.** A live key pasted back to the owner turned into `rk_live_••••` and the owner copied the **dots**. Never ask the owner to copy a key from the chat. Have them copy **directly from Stripe/Telegram** into the **Supabase website** (Edge Functions → Secrets → Edit → paste → Save).
2. **The in-app browser pane's clipboard does not reach Windows**, and **terminal typing in the desktop terminal tab gets garbled** (characters echoed twice, secrets saved as junk like a piece of the command itself). Symptoms we hit: `invalid ByteString` (non-ASCII chars in a header), "Invalid API Key provided: rk_live_", webhook "bad signature". Diagnostics that helped: temporarily return **only the length/char-codes** of a secret from a function (never its content). `create-checkout` also strips non `[A-Za-z0-9_]` from the key.
3. **ntfy.sh free limits are per IP.** Supabase's shared egress IP hits "429 daily quota" even with an account. ntfy is therefore only a weak backup. **Telegram is the real channel.**
4. **Chrome form restore** can re-fill the order form after a reload, so an automated "no thanks" click can submit a **real order**. In tests, **stub `window.fetch` and `window.open` before clicking**. Nudge dialogs have text in `textContent`, not `innerText`.
5. Long bash heredocs with apostrophes fail silently on this machine: **write scripts with the Write tool, then run them**.
6. Browser pane screenshots lag one action behind; wait or re-screenshot. Coordinates change when banners appear.
7. Supabase CLI: `supabase db push` is forbidden; `functions deploy` sometimes returns a transient 500, retry. There is no `functions logs` command; add temporary JSON diagnostics instead.
8. Stripe Workbench webhook UI: preselected events via URL get **toggled off** if clicked again; verify the "Selected events" count.
9. Stripe key creation requires an **identity verification** step that only the owner can do.
10. The Apps Script relay needs a **new version** (Deploy → Manage deployments → pencil → New version) after edits; the URL stays the same. It now has two paths: public enquiry (`TOKEN`) and private `receipt` (`RECEIPT_TOKEN`, the browser never has it).

---

## 8. Alerts/receipts reliability design

- Pay-online orders notify **only after payment** (webhook → `recordPaidSession` → `notifyAll`). `notify_payload` is cleared after the first successful confirmation, so retries never double-alert.
- If the webhook fails, the customer's **"Confirming your payment…"** screen calls `create-checkout` `status`, which **asks Stripe for the session** and records the payment itself (same function, idempotent).
- Stripe also retries failed webhook deliveries automatically for up to 3 days. Failed ones can be **resent** in Workbench → Webhooks → Event deliveries.
- A failed ntfy/Telegram send never blocks the customer receipt or the order.

---

## 9. Dashboard changes (repo `pharaohs-bites-finance`)

- **Payments page → "Payment collector":** unpaid orders (oldest first, "N d old"), **Remind** (WhatsApp link) and **Collect** (opens the Record-payment modal; `PaymentModal` is now exported from `OrderDetail.tsx`).
- Order status label **"Pending WhatsApp Confirmation" → "Pending"**; banner/insight wording "pending order(s) to confirm".
- Website orders now arrive **Confirmed** (non-paying path) or **Pending → Confirmed after payment**. Existing pending ones were converted.
- Empty-state text on Orders no longer mentions WhatsApp.
- Typecheck clean, **40 tests passing**. Lint: only minor warnings.
- **Not done yet:** a full **click-through QA of the live dashboard** (needs the owner to sign in; the login page cannot be automated). See section 11.

---

## 10. Decisions already made with the owner (do not re-ask)

- **Delivery only for now**; pickup hidden but ready.
- **Pickup address is shown publicly** when pickup is enabled (owner chose that), without apartment number.
- **No SMS / automatic WhatsApp** for now (free only): Twilio needs ~$20 + US approval; Meta WhatsApp API is slow. Email receipt + Telegram only.
- **Tax not charged online yet.** Revisit after the accountant answers.
- Money-impact items (prices, fees) always confirmed with the owner first.
- The owner said: "no one has our website yet, I haven't started marketing", so changes can go live without a staging step, but still **test before pushing**.

---

## 11. Open items / next steps (rough priority)

1. **QA tour of the live dashboard** (owner signs in on the in-app browser, then check every page after the data cleanup: Home, Orders, Menu & Profit, Sales by Dish, Customers, Payments, Expenses, Cost, Reports, Tax, Insights, Performance, Deliveries, Data, Settings; confirm zeros are correct, profit = −$110 operating expenses only, no broken layouts/errors; fix gaps). Remember the dashboard **mobile** layout too.
2. **Refund the two live $2.50 test payments** (owner).
3. **Stripe tax ID review** must clear for payouts; re-check Account status in a few days. Confirm the first payout date.
4. **County DBA filing deadline Fri 2026-10-02** (owner, in person; details in the private email).
5. Decide **fake reviews** on the site (still pending from handoff #1), delivery windows vs 24/7, tax status of drinks/desserts, About banner photo.
6. Optional: rotate the keys listed in section 5; change Stripe public name to "Pharaohs Bites" if it should match legal records.
7. Optional: add Arabic dish names to the **email receipt**; SMS/WhatsApp auto-receipts if the owner later wants to pay for them.
8. Update stale docs (`README.md`, `docs/SESSION-LOG.md`, website `PROJECT-LOG.md`) to describe the current flow.

---

## 12. Working rules with this owner (unchanged, repeated for a fresh chat)

- **Short replies.** Lead with what changed and what they must do; detail goes in files like this one.
- English with some Egyptian Arabic in Latin letters ("5alas", "3awz"). Types fast with typos; interpret intent. Sends **new instructions mid-task**, treat them as additions.
- Non-technical: do steps yourself (git, deploy, Supabase CLI, browser pane). When the owner must act, give **3 to 4 numbered clicks**, one step at a time, with links.
- Never enter passwords, card numbers, bank details, ID numbers or API keys on the owner's behalf; **never read secrets back**. The owner pastes secrets (via the Supabase website).
- Ask before deleting, changing money/prices, or anything customer-visible in a new way. Do not create test orders in production without saying so; delete them after (soft delete via `update orders set deleted_at = now() ...`).
- Verify visually on phone widths (320 to 390 px) and desktop. Most bugs are layout bugs.
- Environment: Windows 11, git-bash + PowerShell, `supabase` CLI linked to the project, `gh` authenticated as `morcosfady`. Stop local servers with PowerShell `Stop-Process` (no `pkill`).

---

## 13. Quick runbooks added this session

**Check a payment end to end (live):** place a small **delivery** order on the site (total ≥ $0.50; a 5-dollar fee already guarantees it) → pay with a real card → expect: Telegram alert after payment, order Paid + Confirmed in the dashboard, receipt email, "Payment received ✅" screen. Refund afterwards in Stripe.

**Re-send a failed Stripe confirmation:** Stripe → Workbench → Webhooks → `pharaohs-bites-payments-live` → Event deliveries → open the failed event → **Resend**.

**Change the delivery price:** edit `FEE_BASE`/`FEE_PER_MILE` in `supabase/functions/_shared/delivery.ts`, redeploy `create-order` and `delivery-quote`, update the text "$5 + $1.75 per mile" in `order.html` (notice), `main.js` (two notes) and the fulfil card.

**Re-enable pickup:** `enablePickup: true` in `config.js`, set `KITCHEN_ADDRESS`/`pickupAddress` as desired, bump versions, push.

**Rotate/replace a secret safely:** copy it **straight from the provider** (Stripe/BotFather/ntfy) in the owner's normal Chrome, then Supabase website → Edge Functions → Secrets → edit → paste → Save. Then verify with a harmless test (see the diagnostics trick in gotcha 2).

**Remove all test data again:** soft-delete orders, void payments, soft-delete test customers (SQL used on 2026-09-30 is in this file's section 3 description; see `supabase/migrations/0043_remove_test_item.sql` for the product part).

---

## 14. Dashboard QA tour (2026-10-01, done after this file was first written)

Method: signed-in owner session in the in-app browser, every route opened at desktop, 768 px and 375 px, text scanned for `NaN/undefined/errors`, forms opened (and cancelled), a temporary silent QA order created and then deleted.

**Bugs found and fixed (all deployed):**
1. **Sideways scrolling on phones/tablets** on Home, Reports and Tax (grids without a single shrinkable column let wide tables stretch the page). Global fix in `src/index.css` (`@layer base { .grid { grid-template-columns: minmax(0,1fr) } }`) plus Tax grid. Verified: **0 overflow on all 15 pages at 375 px and 768 px**.
2. **Payments page listed payments of deleted (test) orders** (and refunds). Queries now use `orders!inner(...)` + `.is("orders.deleted_at", null)` (`src/hooks/queries.ts`); the mock in `src/test/mockSupabase.ts` understands it.
3. **Missing: when must it be delivered?** Added `src/lib/slot.ts` (reads "Delivery window: … on …" from the instructions), a **Deliver** column on Orders (also in simple mode), a **"Deliver Sun, Oct 4 · 12:00 PM–3:00 PM" chip** on the order page, and an **"Upcoming deliveries" card on Home** (`src/components/UpcomingDeliveries.tsx`, confirmed/preparing/ready orders, soonest first).
4. **Missing: customer email.** New `orders.customer_email` (migration `0044`), saved by `create-order` (and onto the customer when empty), shown on the order page and in search. The raw "Delivery window:" tag is hidden from notes (`plainNote`).
5. Truncated KPI labels on Home ("SA…", "ORDERS COMPL…") now wrap; the small cards stack on phones.
6. Dish names on Menu and Sales wrap to two lines instead of being cut.
7. Order items table now fits a phone (Taxable column hidden under 640 px, narrower inputs, placeholder "note").
8. Tax page "Products needing review: 27" counted inactive products; now active only (23).
9. Default WhatsApp message (Settings) no longer says "Please confirm" (migration `0045`).

**Checked and fine:** Home numbers after the cleanup (Sales $0, Profit −$110.00 = the two real expenses), Orders list and detail math, Record-payment modal, Payments "Payment collector" (Remind link + Collect), Customers list/detail, Expenses (bank feed section, subscriptions), Reports, Settings values, bell ("All caught up").

**Still for the owner (not bugs):**
- Menu & Profit says **9 of 23 dishes have no cost entered**, so profit is overstated for those until costs are filled in.
- Expense "Court Solutions LLC $10.00" has no category (probably "Licenses and permits").
- Settings → Owner name, Address and Email are empty.
- Simple mode hides Payments/Deliveries/Tax pages (Settings → Advanced mode shows them).
- Dashboard login cannot be automated; the owner must sign in on the pane for any future live QA.

---

## 15. Update 2026-10-01: Pickup is ON again, with its own time windows

Owner decision (message in Franglais): **offer both Pickup (free) and Delivery (fee unchanged: $5 + $1.75/mile)**, with different windows:
- **Delivery windows:** 8:00 AM–11:00 AM or 8:00 PM–11:00 PM (ids `d1`, `d2`)
- **Pickup windows:** 2:00 PM–4:00 PM, 4:00 PM–6:00 PM, 6:00 PM–8:00 PM (ids `p1`, `p2`, `p3`; changed from 11-2, 2-5, 5-8 on 2026-10-01)

Changes (website repo): `config.js` → `enablePickup: true`; `main.js` → `WINDOWS` now has a `mode` per window, `windowsForMode()`, `renderWindows()` inside `initSchedule` (re-rendered by `applyFulfillment()` through `rerenderSchedule`), `scheduleComplete()` requires the window to match the chosen mode, hints/notes say "pickup"/"delivery" accordingly. Switching the mode clears the chosen window but keeps the date. The site wording was reverted from "delivery only" back to "pickup and delivery" (git revert of the wording commit). The server needed no change (it already supports `fulfillment: "pickup"`). Pickup address is shown on the page when Pickup is selected (`config.pickupAddress`) and in the receipt/confirmation. Telegram says "PICKUP ON", the dashboard shows a "Pickup …" chip.

Note: the instruction tag is still written as "Delivery window: … on …" for pickups too (the dashboard and Telegram parse that exact prefix), so do not rename it without updating `src/lib/slot.ts` and `_shared/notify.ts`.
Sections 4, 10 above that say "pickup hidden / delivery only" are **superseded by this section**.
