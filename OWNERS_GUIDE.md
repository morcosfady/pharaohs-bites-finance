# Pharaoh's Bites Finance Dashboard: Owner's Guide

Sign in at **https://morcosfady.github.io/pharaohs-bites-finance/** with the
email and password created for you in Supabase. Nobody else can register.

## Simple or advanced
The dashboard starts simple: six tabs and a New → Confirmed → Done order flow.
When you want more (refunds, deliveries, best sellers, sales-tax periods,
recipes…), open **Settings**, tick **Advanced mode** and save.

## Confirm an order
1. A new website order shows up in **Orders** as *Pending WhatsApp Confirmation*
   (the bell icon and the Orders badge count them).
2. Open it. Check the items, address and requested time.
3. Use the status buttons at the top: *Contacted -> Delivery Fee Pending ->
   Awaiting Customer Approval -> Confirmed -> Preparing -> Ready -> Out for
   Delivery -> Completed*. Each change is logged in the order's history.
4. **Cancel** and **Refunded** ask you to confirm first. Cancelled orders never
   count as sales.

## Add the delivery fee
On the order page, under **Delivery**, type the distance in miles. Click
*Use suggested fee* (miles x your rate from Settings) or type your own fee in
**Delivery fee charged**. Enter the **actual delivery cost** (fuel/courier) so
the delivery profit is right. Choose whether the customer pays the fee or the
business absorbs it.

Then press **WhatsApp customer**: the message template from Settings is
pre-filled with the order number, delivery fee and total.

## Sales tax on an order
The tax rate from **Sales Tax** settings is applied automatically to lines
marked *taxable*. Untick *taxable* on a line to exclude it, change the rate for
this order, or tick *set tax manually* and type the amount. The figure is an
estimate; the order keeps whatever you decided.

## Record a payment
Order page -> **Record payment**: amount (defaults to the balance), Zelle /
Venmo / cash / card, reference and date. Several payments per order are fine;
the payment status (unpaid -> partially paid -> paid) updates itself. Void a
payment if it was entered by mistake; it stays in the audit trail.

## Record a refund
Order page -> **Refund**: amount, method, reason and, if tax was included, the
tax portion (this reduces your estimated tax liability). The original payment
is never deleted.

## Record an expense
**Expenses -> Add expense**: date, vendor, category, amount before tax, sales
tax paid, how you paid, and a photo of the receipt (the phone camera opens
directly). Choose *Direct product cost* for ingredients/packaging and
*Operating expense* for everything else. Tick a recurrence for monthly bills.

## Update product costs
**Products -> open a product -> Recipe**. Add each ingredient with the quantity
you use per unit; the package size and price on the ingredient give the cost
automatically (a $10 / 10 lb bag with 1 lb used = $1.00). Packaging and
labor minutes are on *Edit product*. Past orders keep the cost that applied
when they were sold.

## See your profit
**Dashboard** shows net sales, cost of goods, gross profit and estimated net
profit for the chosen period, each with the change versus the previous
period. Hover the (i) on any card for the exact formula. **Reports -> Profit &
loss** shows the full statement.

## See estimated sales tax
**Sales Tax** lists each reporting period with taxable / nontaxable sales, tax
collected and the estimated amount due, plus a reminder before the next due
date. After you file, press *Mark filed* and update the next due date. These
are estimates: confirm with the Texas Comptroller or your accountant.

## Export reports
Every list has **Export CSV**. **Reports** has CSV and *Print / PDF* (use the
browser's *Save as PDF*). **Import / Export** has a full JSON backup.

## Phone tips
The bottom bar gives you Home, Orders, Products, Expenses and Reports; the
menu button has everything else. Tables become cards; tap a card to open it.
