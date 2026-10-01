# Combo pricing (APPROVED and built 2026-10-01)

Approved: Egyptian Breakfast $39.50, Family Feast $69, Meal for One $30.50 (Feteer Meshaltet only), Party Tray $89.50 (1 main + Sides Platter + 4 puddings). Pick Any 3 Puddings is now $15 (no discount). Sweet Feteer Box, Shake + Sweet and Comfort Meal stay blocked. Packaging stays a $0.50 per item placeholder.

Date: 2026-10-01. Costs and prices come from the live `products` table.

## How the numbers were worked out
- **Full price** = regular prices added up. For "choice" slots the cheapest option is used, so "you save" is always true.
- **Cost** = ingredient cost, using the most expensive option for "choice" slots (worst case).
- **Packaging** = **placeholder $0.50 per item**. The database has $0 packaging for every product, so this is a guess. Real numbers will move every margin below.
- **Stripe fee** = 2.9% of the combo price + $0.30.
- **Discount** = the smaller of 10% of full price and 25% of profit before discount. Price rounded up to the next $0.50. Minimum saving $1.
- **Profit** = price - cost - packaging - Stripe fee. **Margin** = profit / price. Must be at least 50%, and profit must beat the best single item inside the combo.
- Delivery fee is never included.

## New combos

| Combo | Contents | Full price | Combo price | You save | Cost | Pkg | Stripe | Profit | Margin | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| 🍯 Sweet Feteer Box | mini sweet feteer + 1 pudding | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | ⛔ Blocked: mini sweet feteer is inactive and has cost $0 |
| 🍽️ Family Feast | Feteer Meshaltet + 1 main (macarona or kofta) + 2 different sides + 2 puddings | $76.50 | **$69.00** | $7.50 | $26.70 | $3.00 | $2.30 | $37.00 | 54% | ⚠️ packaging is a guess |
| 🥣 Comfort Meal | lentil soup + bread + 1 side | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | ⛔ Blocked: no bread on the menu |
| ☀️ Egyptian Breakfast | Feteer Meshaltet + white cheese + black honey + tahini + 1 shake | $43.50 | **$39.50** | $4.00 | $9.69 | $2.50 | $1.45 | $25.86 | 65% | ⚠️ packaging is a guess, registration flag |
| 🍝 Meal for One | 1 main + 1 side + 1 pudding | $33.00 | see note 1 | | | | | | | ⚠️ the spec as written fails |
| 🎉 Party Tray | 2 mains + Sides Platter + 6 puddings | $99.00 | see note 2 | | | | | | | ⚠️ the spec as written fails |
| 🥤 Shake + Sweet | shake + mini sweet feteer | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | ⛔ Blocked: same mini sweet feteer problem |

**Note 1, Meal for One.** With all four mains (feteer $25, meatballs $30, macarona $35, kofta $40) the worst case is a $35 tray that costs $14.53 sold next to a $25 price tag, so margin is below 50% at any price. Proposed fix: main = **Feteer Meshaltet** only, plus 1 side of choice and 1 pudding of choice. Full $33.00, price **$30.50**, save $2.50, cost $8.38, profit $19.44, margin 64%.

**Note 2, Party Tray.** Six puddings only make about 44% margin each, which drags the whole tray under 50%. Proposed fix: **1 Feteer Meshaltet + 1 main of choice (macarona or kofta) + Sides Platter + 4 puddings**. Full $99.00, price **$89.50**, save $9.50, cost $35.48, profit $47.62, margin 53%. (Another option that also passes: 2 Feteer Meshaltet + Sides Platter + 4 puddings at $80.50, save $8.50, margin 61%.)

## Existing combos checked against the same rules (not changed)

| Combo | Price now | Margin | Result |
|---|---|---|---|
| Feteer + Dip Trio | $32 | 69% | ✅ passes |
| Sides Platter | $19 | 51% | ✅ passes, but only just (the $3 packaging guess is for 6 items; one box would be cheaper) |
| Pick Any 3 Puddings | $14 | 24% | ⛔ fails. Puddings themselves earn only about 44%, so no discount can pass 50%. Your call: keep it on purpose, or drop it |

## Questions for the owner
1. **Packaging cost** per container (or per combo box). Replaces the $0.50 guess.
2. **Mini sweet feteer:** is it going back on the menu? What does it cost to make? That unlocks Sweet Feteer Box and Shake + Sweet.
3. **Bread:** do you want to sell it? Price and cost? That unlocks Comfort Meal.
4. OK with the **Meal for One** and **Party Tray** changes above?
5. **Pick Any 3 Puddings** at 24% margin: keep or drop?

## Registration check (cottage food list)
Add to the registration before promoting: **baba ganoush, hummus, white honey, rice pudding** (all are inside the Sides Platter or Pick 3 Puddings today). **Black honey, tahini and white cheese** are fine as add-ons to feteer (Egyptian Breakfast), but flag it. Nothing has been removed from the site.

## Single pudding price for a 60% margin (suggestion only, prices not changed)
Pudding cost is $2.79 (Rice Pudding $2.50). Lowest price, rounded up to $0.50:
- Dashboard-style margin (price minus cost): **$7.00** (Rice Pudding $6.50)
- Also counting $0.50 packaging: **$8.50** (Rice Pudding $7.50)
- Also counting the card fee of a one-item order: **$10.00**
Today's price is $5 (Rice Pudding $6), which is 44% (58%) on the dashboard-style margin.
