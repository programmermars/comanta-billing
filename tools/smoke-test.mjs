// Quick checks of the money, numbering and document code (no database needed): npm run check
import assert from "node:assert/strict";
import {
  money, toSen, calc, invoiceAmounts, formatNumber, normalizeNumber, amountInWords, renderDoc, renderReceipt, addDays,
} from "../src/billing-core.js";

assert.equal(money(123456), "1,234.56");
assert.equal(toSen("RM 1,200.50"), 120050);
assert.equal(toSen(12.345), 1235);

const { items, subtotal, discount, total } = calc([{ desc: "A", qty: 2, price_sen: 15000 }, { desc: "", qty: 1, price_sen: 999 }, { desc: "B", qty: 0.5, price_sen: 10000 }], 5000);
assert.equal(items.length, 2);
assert.equal(subtotal, 35000);
assert.equal(discount, 5000);
assert.equal(total, 30000);

assert.deepEqual(invoiceAmounts({ total_sen: 200000, bill_sen: null, paid_sen: 50000 }), { bill: 200000, paid: 50000, balance: 150000 });
assert.deepEqual(invoiceAmounts({ total_sen: 200000, bill_sen: 100000, paid_sen: 0 }), { bill: 100000, paid: 0, balance: 100000 });

assert.equal(formatNumber("invoice", 2026, 1), "INV-2026-0001");
assert.equal(formatNumber("quote", 2026, 12, "acme"), "ACME-QT-2026-0012");
assert.equal(normalizeNumber("inv-2026-1", "ACME"), "ACME-INV-2026-0001");
assert.equal(normalizeNumber("RCPT-2026-007"), "RCPT-2026-0007");

assert.equal(amountInWords(50000), "Ringgit Malaysia Five Hundred Only");
assert.equal(amountInWords(123450), "Ringgit Malaysia One Thousand Two Hundred Thirty-Four and Sen Fifty Only");
assert.equal(addDays("2026-12-30", 7), "2027-01-06");

const settings = { biz_name: "Demo Studio", bank_name: "Demo Bank", bank_account_name: "Demo Studio", bank_account_no: "", invoice_due_days: "7", sst_note: "No SST." };
const doc = { kind: "invoice", number: "INV-2026-0001", issue_date: "2026-11-19", end_date: "2026-11-26", status: "sent", items: JSON.stringify(items),
  discount_sen: 5000, total_sen: 30000, bill_sen: 30000, paid_sen: 10000, paid_date: "2026-11-17", invoice_type: "full" };
const html = renderDoc(doc, { company: "Contoh <Sdn> Bhd" }, settings);
assert.ok(html.includes("Advance received (17 Nov 2026)"), "advance label");
assert.ok(html.includes("200.00"), "balance shown");
assert.ok(html.includes("Contoh &lt;Sdn&gt; Bhd"), "client name escaped");
assert.ok(html.includes("(to be advised)"), "empty bank account placeholder");
const rc = renderReceipt({ number: "RCPT-2026-0001", amount_sen: 10000, paid_date: "2026-11-17", status: "issued", created_at: "2026-11-19 10:00:00" }, doc, {}, settings, { receivedToDate: 10000 });
assert.ok(rc.includes("Ringgit Malaysia One Hundred Only") && rc.includes("OFFICIAL RECEIPT"));

console.log("smoke test: all checks passed");
