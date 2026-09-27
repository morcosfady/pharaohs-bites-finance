# Pharaoh's Bites — work log & handover

Everything built and changed in this chat, plus what's left to do.

---

## 1. Links

| What | URL |
| --- | --- |
| Customer website (live) | https://morcosfady.github.io/pharaohs-bites/ |
| Finance dashboard (live, login required) | https://morcosfady.github.io/pharaohs-bites-finance/ |
| Dashboard demo (sample data, no login) | https://morcosfady.github.io/pharaohs-bites-finance/demo/ |
| Website repo | https://github.com/morcosfady/pharaohs-bites |
| Dashboard repo | https://github.com/morcosfady/pharaohs-bites-finance |
| Supabase project | https://vvwunhcpxofvnjijemdb.supabase.co |
| Logo concepts (line-art drafts, not used) | https://claude.ai/code/artifact/24c19678-adef-4105-8315-e6172a29049c |

Local folders: `F:\Portfolio\Nile Bites` (website) · `F:\Portfolio\pharaohs-bites-finance` (dashboard).
The website's local folder is still named "Nile Bites"; only the folder name, nothing depends on it.

---

## 2. Customer website — what changed

**Naming & hosting**
- Repo renamed `nile-bites` → `pharaohs-bites`; the old `…/nile-bites/` URL is dead.
- There was already an empty `pharaohs-bites` repo (one uploaded `index.html`); you deleted it first.

**Menu**
- Added **Plant-Based Kofta Tray with Salsa & Rice — $35** and **Plant-Based Meatballs & Spaghetti — $25** (21 items total).
- Menu page rebuilt to match the Order page: photo rows with Arabic name, tags, price, ♥ and a gold **Add** button feeding the same basket, plus a floating "Your order → Checkout" pill.

**Branding**
- Your gold pharaoh emblem is now the hero image, header mark, footer logo, favicon, phone icon and social-share image.
- Added a gold Egyptian glyph set (ankh, Eye of Horus, scarab, feather of Ma'at, lotus, djed) used as a strip under every hero, eyebrow markers, alternating dividers, marquee separators, stats flanks, menu counts and footer titles.
- Removed the large translucent pharaoh watermark from page backgrounds (you didn't like it).
- Hero wordmark made larger and white; nav tabs enlarged; right winged-disk ornament aligned with the left one.

**Structure**
- Removed the **Bakery** and **Gallery** tabs and pages, and every link to them.
- Merged **Our Story** into **About Us** (`about.html#our-story`); nav is now Home · About Us · Menu · Catering · Contact.

**Photos**
- All 54 images reviewed; the wrong ones replaced (pancakes for feteer, a burger for the goulash tray, bibimbap for tahini, blue cheese for white cheese, etc.).

**Checkout**
- Order review panel: item, quantity, unit price, line total, subtotal, and the notice *"Delivery fee is not included…"*.
- Required: full name, **phone**, street, city, state, ZIP. Optional: apartment, delivery instructions, requested date/time.
- Big WhatsApp-green button (`#25D366`) "Complete Order on WhatsApp", disabled until the basket has items and every required field is filled.
- On click: the order is saved to the finance database **first**, then WhatsApp opens to **+1 787-968-4078** with the order number in the message. Double-clicks and refreshes reuse the same token → no duplicate orders. On failure: clear error + **Try again**, nothing lost.

**Message format** (emoji-rich, URL-encoded):

```
👑✨ NEW PHARAOH'S BITES ORDER ✨👑
🔖 Order Number: PB-2026-00001

👤 CUSTOMER
🖊️ Name: …      📞 Phone: …
📍 Address: …    📝 Delivery Instructions: …

🛒 ORDER
🍽️ 1. Feteer Meshaltet
🔢 Quantity: 2   💵 Unit Price: $14   🧾 Line Total: $28

💰 Merchandise Subtotal: $35
🚗 Delivery Fee: To be determined
🧮 Estimated Tax: To be confirmed
✅ Final Total: To be confirmed
🗓️ Requested Date/Time: …

💳 Payment via Zelle or Venmo after the delivery fee and final total are confirmed.
🙏 Please confirm my order and delivery fee. Thank you! 😊
```

---

## 3. Finance dashboard — what was built

Private, owner-only. React + TypeScript + Vite + Tailwind + Recharts on GitHub Pages; Supabase for database, login, file storage and realtime.

**Database (`supabase/migrations/`, 24 tables)**
- Orders, order items (with a cost snapshot per line), status history, payments, refunds, deliveries, customers + addresses, products, ingredients, recipes, cost history, expenses, tax settings/adjustments/periods, business settings, audit log.
- Order numbers `PB-2026-00001`, generated server-side and safe when two people order at once.
- Totals, estimated tax and payment status are recalculated by database triggers — never trusted from the browser.
- Money stored as `numeric(12,2)`; the app does arithmetic in integer cents.
- Financial rows are voided / soft-deleted, never erased; every change is written to `audit_logs`.

**Security**
- Row Level Security on every table: only users listed in `admin_profiles` can read or write anything. Anonymous visitors have no grants at all; a logged-in non-admin gets nothing back.
- Public sign-up disabled in Supabase.
- The website never touches tables — it calls the `create-order` Edge Function, which validates every field, re-prices from the catalogue, rejects unknown/inactive products, rate-limits per IP, allows only `morcosfady.github.io`, and returns just the order number.

**Screens** — Home, Orders (+ order page), Products (+ product page & recipe costing), Customers, Expenses, Reports, and in Advanced mode also Best Sellers, Payments, Deliveries, Sales Tax, Insights, Import/Export, Settings.

**Simple mode (default)** — six tabs, four headline numbers (Sales, Profit, Orders completed, Money still owed), a **New → Confirmed → Done → Cancelled** order flow and short forms. *Settings → Advanced mode* reveals all 11 statuses, refunds, cost breakdowns, tax overrides, recipes and every report.

**Other details**
- ✏️ pencil buttons on every row and section for editing.
- Customers tab shows orders count and **lifetime total** per customer, plus a total across everyone.
- Customer status: Active · **VIP (green)** · **Trouble maker (red)** · Blocked (black).
- Sales-tax page: estimates only, with reminders and a disclaimer; collected tax is never counted as income.
- Everything responsive; tables become cards on the phone.

**Tests** — 38 automated tests (money maths, KPI formulas, product rankings, date filters, CSV, WhatsApp message format, login guard, table sorting/pagination) plus a SQL test file for RLS and calculations. CI runs typecheck + tests before every deploy.

---

## 4. Setup completed

1. ✅ Supabase project `pharaohs-bites` created (US East).
2. ✅ All 5 migrations run — tables, security and your 21 products loaded.
3. ✅ Public sign-ups disabled.
4. ✅ Admin user created: `morcos.fady94@gmail.com` (UID `aff02bb0-eec0-4d0a-a2e5-2aba2975b92a`) and added to `admin_profiles`.
5. ✅ Project URL + publishable key stored as GitHub secrets; dashboard rebuilt and login screen live.
6. ✅ `create-order` Edge Function deployed (verified: rejects bad data and foreign origins).
7. ✅ Website `config.js` pointed at the function; deployed.

**Still to do**
- ⬜ **Place the test order** — website → add items → fill details → *Complete Order on WhatsApp* → check it appears in the dashboard under **Orders** as *New*.
- ⬜ **Rotate the Supabase secret key** — it was visible in a screenshot. Project Settings → API Keys → delete the `sb_secret_…` key and create a new one. Nothing we built uses it.
- ⬜ Optional: set your real phone number in the website footer/contact (still the `(214) 555-0100` placeholder), and set the sales-tax filing frequency and next due date on the Sales Tax page.

---

## 5. Notes we agreed on

- **Sales tax:** Dallas combined rate **8.25%** (6.25% state + 2.00% local). Prepared food is taxable; delivery fees on a taxable sale are taxable too. You need a Texas Sales and Use Tax Permit before charging it. The dashboard produces *estimates* — confirm with the Comptroller or an accountant.
- **Delivery pricing (Uber courier):** suggested **$10 flat within ~7 miles**, **$15 for 7–15 miles**, quote-per-order beyond that, free delivery over ~$75 inside the near zone. Uber typically costs $7–18 depending on distance.
- **Cost:** everything runs on free tiers — GitHub Pages, Supabase Free, plain WhatsApp links. Supabase pauses a project after a full week of no use and wakes on the next visit. Use the dashboard's **Full backup (JSON)** button regularly since automatic backups are a paid feature.
- **WhatsApp limitation:** the dashboard cannot read your WhatsApp messages. Orders are captured from the *website* before WhatsApp opens; you move them through the statuses yourself. Orders that arrive by WhatsApp only must be added with **Manual order**. `docs/WHATSAPP_CLOUD_API.md` explains what Meta's Cloud API would require if you ever want incoming messages synced.

---

## 6. Documentation in the repo

- `README.md` — architecture, setup, Supabase, RLS, deployment, backups, troubleshooting.
- `OWNERS_GUIDE.md` — plain-English how-to for daily use.
- `docs/WHATSAPP_CLOUD_API.md` — WhatsApp limits and the future Cloud API plan.
- `supabase/ALL_MIGRATIONS.sql` — all migrations in one file.
- `supabase/seed.dev.sql` — sample data, development only.
