/* Year-end Tax Pack PDF for the accountant. The PDF libraries are loaded only when the owner taps
   Download, so they never weigh down the dashboard. Draft bookkeeping summary, not tax advice. */
import type { ExpenseTaxRow, MileageLog, TaxExtras, TaxQuality, TaxSummaryRow } from "./types";
import { lineForm, lineLabel, qualityIssues, sortLines, startupStatus } from "./taxpack";
import { summarizeMileage } from "./mileage";

export interface TaxPackData {
  year: number; businessName: string; startDate: string; assetThreshold: number; startupLimit: number;
  method: "standard" | "actual"; methodConfirmed: boolean;
  summary: TaxSummaryRow[]; rows: ExpenseTaxRow[]; quality: TaxQuality | undefined; extras: TaxExtras | undefined; mileage: MileageLog[];
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function buildTaxPdf(d: TaxPackData): Promise<Blob> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const W = doc.internal.pageSize.getWidth();
  let y = 48;
  const gold: [number, number, number] = [176, 137, 52];
  const teal: [number, number, number] = [15, 77, 70];
  const after = () => ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 18;
  const heading = (t: string) => { if (y > 700) { doc.addPage(); y = 48; } doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(...teal); doc.text(t, 40, y); y += 8; };
  const note = (t: string) => { doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(90); const lines = doc.splitTextToSize(t, W - 80) as string[]; doc.text(lines, 40, y + 10); y += 10 + lines.length * 11 + 6; };

  doc.setFont("helvetica", "bold"); doc.setFontSize(20); doc.setTextColor(...teal);
  doc.text(`${d.businessName}: Tax Pack ${d.year}`, 40, y); y += 20;
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(90);
  doc.text(`Prepared ${new Date().toLocaleDateString("en-US")} for the accountant. Schedule C (sole proprietor). Business start date ${d.startDate}.`, 40, y); y += 14;
  doc.setTextColor(...gold); doc.setFont("helvetica", "bold");
  doc.text("DRAFT. Bookkeeping support, not tax advice. Line mapping and every item marked Ask accountant must be confirmed.", 40, y); y += 18;

  // 1. data quality
  const issues = qualityIssues(d.quality);
  heading("1. Data quality");
  if (!issues.length) note("Clean: no unmatched deposits, duplicates, uncategorized expenses, missing receipts or estimated mileage.");
  else {
    note(issues.some((i) => i.blocking) ? "NOT CLEAN. These items should be fixed before filing:" : "Clean except for these warnings:");
    autoTable(doc, { startY: y, head: [["Issue", "Type"]], body: issues.map((i) => [i.text, i.blocking ? "Fix before filing" : "Warning"]), theme: "grid", headStyles: { fillColor: teal }, styles: { fontSize: 9 }, margin: { left: 40, right: 40 } });
    y = after();
  }

  // 2. totals by line
  const lines = sortLines(d.summary);
  const deductibleLines = lines.filter((l) => !["startup", "uncategorized", "refunds"].includes(l.line_key));
  const totalDeductible = deductibleLines.reduce((s, l) => s + Math.round(Number(l.deductible) * 100), 0) / 100;
  heading("2. Expenses by Schedule C line (draft mapping)");
  autoTable(doc, {
    startY: y, head: [["Line", "Description", "Entries", "Spent", "Deductible"]],
    body: [...lines.map((l) => [lineForm(l.line_key), lineLabel(l.line_key), String(l.entries), money(Number(l.total)), money(Number(l.deductible))]),
      ["", "Total deductible, excluding startup costs, refunds and uncategorized", "", "", money(totalDeductible)]],
    theme: "grid", headStyles: { fillColor: teal }, styles: { fontSize: 9 }, columnStyles: { 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" } }, margin: { left: 40, right: 40 },
  });
  y = after();

  // 3. startup
  const st = startupStatus(Number(lines.find((l) => l.line_key === "startup")?.deductible ?? 0), d.startupLimit);
  heading("3. Startup costs (before the business start date)");
  note(`Total ${money(st.total)} against a draft first-year limit of ${money(st.limit)}: ${st.withinLimit ? `within the limit (${money(st.remaining)} left)` : `${money(st.over)} over the limit`}. Ask accountant: startup election, amortization of any excess, and which items qualify.`);
  const startupRows = d.rows.filter((r) => r.is_startup);
  if (startupRows.length) { autoTable(doc, { startY: y, head: [["Date", "Vendor", "Category", "Amount"]], body: startupRows.map((r) => [r.expense_date, r.vendor, r.category_name, money(Number(r.total_amount))]), theme: "grid", headStyles: { fillColor: teal }, styles: { fontSize: 9 }, margin: { left: 40, right: 40 } }); y = after(); }

  // 4. mileage
  const m = summarizeMileage(d.mileage);
  heading("4. Mileage");
  note(`Method: ${d.method === "standard" ? "standard mileage rate" : "actual car expenses"}${d.methodConfirmed ? " (accountant confirmed)" : " (NOT yet confirmed: ask accountant)"}. ${m.miles.toFixed(1)} business miles in ${m.trips} trips. Deduction ${money(m.deduction)} at the IRS rate in force on each trip date. ${m.estimatedMiles > 0 ? `${m.estimatedMiles.toFixed(1)} miles are estimates from the delivery fee formula, not an odometer: ask accountant. ` : ""}${d.method === "standard" ? "Gas for the vehicle is excluded from the expense totals above." : ""}`);
  const trips = d.mileage.filter((r) => r.counted);
  if (trips.length) { autoTable(doc, { startY: y, head: [["Date", "Purpose", "From to", "Miles", "Rate", "Deduction"]], body: trips.map((r) => [r.trip_date, r.purpose, `${r.from_label} to ${r.to_label}`, Number(r.miles).toFixed(1) + (r.estimated ? " est." : ""), r.cents_per_mile == null ? "none" : `${Number(r.cents_per_mile)}c`, r.deduction == null ? "none" : money(Number(r.deduction))]), theme: "grid", headStyles: { fillColor: teal }, styles: { fontSize: 8 }, margin: { left: 40, right: 40 } }); y = after(); }

  // 5. assets
  const assets = d.rows.filter((r) => r.asset_candidate);
  heading("5. Possible assets");
  if (!assets.length) note(`No single purchase at or above ${money(d.assetThreshold)}.`);
  else { note(`Purchases at or above ${money(d.assetThreshold)}. Ask accountant: depreciate or expense?`); autoTable(doc, { startY: y, head: [["Date", "Vendor", "Description", "Amount"]], body: assets.map((r) => [r.expense_date, r.vendor, r.description, money(Number(r.total_amount))]), theme: "grid", headStyles: { fillColor: teal }, styles: { fontSize: 9 }, margin: { left: 40, right: 40 } }); y = after(); }

  // 6. ask accountant
  const asks = d.rows.filter((r) => r.ask_reason);
  heading("6. Items marked Ask accountant");
  if (!asks.length) note("None.");
  else { autoTable(doc, { startY: y, head: [["Date", "Vendor", "Amount", "Why"]], body: asks.map((r) => [r.expense_date, r.vendor, money(Number(r.total_amount)), r.ask_reason ?? ""]), theme: "grid", headStyles: { fillColor: teal }, styles: { fontSize: 8 }, columnStyles: { 3: { cellWidth: 250 } }, margin: { left: 40, right: 40 } }); y = after(); }

  // 7. excluded
  heading("7. Left out on purpose");
  const x = d.extras;
  note(x ? `Personal spending excluded: ${money(x.personal_total)} (${x.personal_count} items). Money the owner put in (not income): ${money(x.owner_contributions)}. Stripe payouts (income is counted from orders, not from payouts): ${money(x.stripe_payouts)}. Transfers between own accounts: ${money(x.transfers)}.` : "Not available.");

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120); doc.text(`${d.businessName} Tax Pack ${d.year}, DRAFT. Page ${i} of ${pages}`, 40, 770); }
  return doc.output("blob");
}
