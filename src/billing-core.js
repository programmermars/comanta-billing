// Shared by the Worker (src/billing.js) and the command-line tool (tools/billing.mjs):
// money and date helpers, numbering and the printable quotation / invoice page.
// Plain JavaScript only (no Cloudflare or Node imports) so both can use it.

// Quick picks when writing a quote (type in the description box to see them). Edit to match your own price list.
export const CATALOG = [
  { desc: "Consulting (per hour)", price: 150 },
  { desc: "Website setup", price: 1500 },
  { desc: "Automation setup", price: 2500 },
  { desc: "Monthly maintenance", price: 300 },
  { desc: "Training workshop (half day)", price: 1200 },
];

export const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// 123456 sen -> "1,234.56"
export const money = sen => (Math.round(Number(sen) || 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// "RM 1,200.50" / "1200.5" / 1200 -> sen (integer); anything unreadable -> 0
export function toSen(v) {
  if (typeof v === "number") return Math.round(v * 100);
  const m = String(v ?? "").replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Math.round(parseFloat(m[0]) * 100) : 0;
}

// Today's date in Malaysia (UTC+8) as YYYY-MM-DD.
export function myToday(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
export function addDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}
export const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
export function fmtDate(ymd) {
  if (!isYmd(ymd)) return "";
  return new Date(ymd + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// Items: [{desc, qty, price_sen}] -> cleaned list plus totals.
export function calc(items, discountSen = 0) {
  const list = (Array.isArray(items) ? items : [])
    .map(it => ({
      desc: String(it.desc ?? "").replace(/\r/g, "").trim().slice(0, 600),
      qty: Math.max(0, Math.round((Number(it.qty) || 0) * 100) / 100),
      price_sen: Math.round(Number(it.price_sen) || 0),
    }))
    .filter(it => it.desc && it.qty > 0)
    .slice(0, 40);
  const subtotal = list.reduce((s, it) => s + Math.round(it.qty * it.price_sen), 0);
  const discount = Math.max(0, Math.min(subtotal, Math.round(Number(discountSen) || 0)));
  return { items: list, subtotal, discount, total: subtotal - discount };
}

// What an invoice asks for: the billed part (deposit/balance/full), what is paid, what is left.
export function invoiceAmounts(doc) {
  const bill = doc.bill_sen == null ? doc.total_sen : doc.bill_sen;
  const paid = doc.paid_sen || 0;
  return { bill, paid, balance: Math.max(0, bill - paid) };
}

export const randomToken = () => {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const prefix = kind => (kind === "invoice" ? "INV" : kind === "receipt" ? "RCPT" : "QT");
// ACME-QT-2026-0001 / ACME-INV-2026-0001 / ACME-RCPT-2026-0001, where "ACME" is the number_prefix setting
// (leave it empty for QT-2026-0001). Change it before your first document, not halfway through a year.
const cleanPrefix = pre => String(pre || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
export const formatNumber = (kind, year, n, pre = "") => {
  const p = cleanPrefix(pre);
  return `${p ? p + "-" : ""}${prefix(kind)}-${year}-${String(n).padStart(4, "0")}`;
};
// Accept short forms people type ("inv-2026-1", "INV-2026-001") and return the stored number.
export function normalizeNumber(input, pre = "") {
  const m = String(input || "").toUpperCase().trim().match(/^(?:[A-Z0-9]+-)?(QT|INV|RCPT)-(\d{4})-(\d+)$/);
  if (!m) return String(input || "").toUpperCase().trim();
  return formatNumber(m[1] === "INV" ? "invoice" : m[1] === "RCPT" ? "receipt" : "quote", m[2], parseInt(m[3], 10), pre);
}
// One statement that bumps the yearly counter and returns the new value (works in D1 from the Worker and wrangler).
export const counterSql = (kind, year) =>
  `INSERT INTO counters (name, value) VALUES ('${prefix(kind)}-${Number(year)}', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`;

export function fillTerms(text, settings, doc) {
  return String(text || "")
    .replace(/\{deposit\}/g, String(doc?.deposit_pct ?? settings.deposit_pct ?? 50))
    .replace(/\{due\}/g, String(settings.invoice_due_days ?? 7))
    .replace(/\{email\}/g, settings.email || "")
    .replace(/\{phone\}/g, settings.phone || "");
}

export const STATUS = {
  quote: { draft: "Draft", sent: "Sent", accepted: "Accepted", declined: "Declined", invoiced: "Invoiced" },
  invoice: { draft: "Draft", sent: "Unpaid", paid: "Paid", void: "Void" },
  receipt: { issued: "Issued", void: "Void" },
};

// Icon for the admin pages.
export const LOGO_SVG = '<svg width="40" height="40" viewBox="0 0 36 36" aria-hidden="true"><rect x="7" y="4" width="22" height="28" rx="3" fill="none" stroke="#0F2A4A" stroke-width="3"/><path d="M12 12h12M12 18h12M12 24h7" stroke="#12A39B" stroke-width="3" stroke-linecap="round"/></svg>';

// Your logo on documents: the logo_url setting if set, otherwise the first letter of the business name.
export function logoHtml(settings) {
  if (/^https:\/\/\S+$/.test(settings.logo_url || "")) return `<img src="${esc(settings.logo_url)}" alt="" style="height:40px;width:auto">`;
  const letter = esc((String(settings.biz_name || "?").trim()[0] || "?").toUpperCase());
  return `<svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="9" fill="#0F2A4A"/><text x="20" y="27" text-anchor="middle" font-family="Arial" font-weight="700" font-size="20" fill="#fff">${letter}</text></svg>`;
}

const nl2br = s => esc(s).replace(/\n/g, "<br>");

export const DOC_CSS = `:root{--navy:#0F2A4A;--teal:#0B7A75;--teal-b:#12A39B;--line:#E3E8EF;--muted:#6B7C90;--bg:#F5F8FB}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--navy);font:14px/1.55 Arial,Helvetica,"Microsoft YaHei",sans-serif}
.bar{max-width:820px;margin:20px auto 0;padding:0 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.bar .btn,.bar button{font:600 14px Arial,sans-serif;border:1px solid var(--teal);background:#fff;color:var(--teal);border-radius:8px;padding:9px 16px;cursor:pointer;text-decoration:none}
.bar .btn.p,.bar button.p{background:var(--teal);color:#fff}
.paper{position:relative;max-width:820px;margin:16px auto 40px;background:#fff;padding:48px 52px;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}
.brand{display:flex;gap:12px;align-items:center}
.brand b{font-size:18px;letter-spacing:.05em}
.from{font-size:12.5px;color:var(--muted);margin-top:8px}
h1{margin:0;font-size:26px;letter-spacing:.08em;color:var(--teal);text-align:right;white-space:nowrap}
.meta{margin-top:8px;font-size:13px;border-collapse:collapse;margin-left:auto}
.meta td{padding:2px 0 2px 14px}.meta td:first-child{color:var(--muted)}
.parties{display:flex;gap:24px;margin-top:30px}
.parties>div{flex:1}
h3{margin:0 0 6px;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.subject{margin-top:22px;font-weight:700}
table.items{width:100%;border-collapse:collapse;margin-top:14px}
.items th{background:var(--navy);color:#fff;font-size:12px;text-align:left;padding:8px 10px}
.items td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.r{text-align:right;white-space:nowrap}.n{width:30px;color:var(--muted)}
.sums{width:340px;margin:12px 0 0 auto;border-collapse:collapse}
.sums td{padding:5px 10px}.sums .tot td{border-top:2px solid var(--navy);font-weight:700;font-size:15px}
.sums .due td{background:var(--teal);color:#fff;font-weight:700;font-size:15px}
.box{margin-top:26px;padding:14px 16px;border:1px solid var(--line);border-radius:8px}
.kv td{padding:2px 14px 2px 0}.kv td:first-child{color:var(--muted)}
.terms{margin-top:22px;font-size:12.5px;color:#4A5D73}
.muted{color:var(--muted)}.ok{color:var(--teal);font-weight:700;margin-top:16px}
.foot{margin-top:30px;padding-top:12px;border-top:1px solid var(--line);font-size:11.5px;color:var(--muted);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.stamp{display:inline-block;float:right;margin-top:10px;border:3px solid var(--teal-b);color:var(--teal-b);font:700 20px Arial;letter-spacing:.2em;padding:3px 14px;border-radius:6px;transform:rotate(-6deg)}
.stamp.void{border-color:#B42318;color:#B42318}
.extra{max-width:820px;margin:0 auto;padding:0 16px}
@media (max-width:640px){.paper{padding:26px 18px;border-radius:0}.top,.parties{flex-direction:column}h1{text-align:left;white-space:normal}.meta{margin-left:0}.meta td{padding-left:0;padding-right:14px}.sums{width:100%}}
@media print{@page{size:A4;margin:12mm}body{background:#fff;font-size:12px;line-height:1.45}
.from{font-size:11px}.parties{margin-top:18px}.subject{margin-top:14px}.items td{padding:6px 8px}.items th{padding:6px 8px}
.sums td{padding:3px 8px}.box{margin-top:14px;padding:10px 12px}.terms{margin-top:14px;font-size:11px}.foot{margin-top:16px}.bar,.extra,.noprint{display:none!important}.paper{margin:0;border:0;padding:0;max-width:none;border-radius:0}.items th,.sums .due td,.stamp{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;

// The printable document (A4). `extra` is HTML placed above the paper (buttons, accept form); it is hidden when printing.
export function renderDoc(doc, client, settings, { extra = "", quoteNumber = "", title = "" } = {}) {
  const isInv = doc.kind === "invoice";
  const items = JSON.parse(doc.items || "[]");
  const { subtotal, discount, total } = calc(items, doc.discount_sen);
  const c = client || {};
  const heading = isInv ? (doc.invoice_type === "deposit" ? "DEPOSIT INVOICE" : "INVOICE") : "QUOTATION";
  const meta = [
    [isInv ? "Invoice no." : "Quotation no.", doc.number],
    ["Date", fmtDate(doc.issue_date)],
    [isInv ? "Due date" : "Valid until", fmtDate(doc.end_date)],
    ...(isInv && quoteNumber ? [["Quotation ref.", quoteNumber]] : []),
  ].filter(r => r[1]);
  const billTo = [
    c.company ? `<strong>${esc(c.company)}</strong>` : "",
    c.company && c.reg_no ? `<span class="muted">${esc(c.reg_no)}</span>` : "",
    c.name ? (c.company ? `Attn: ${esc(c.name)}` : `<strong>${esc(c.name)}</strong>`) : "",
    c.address ? nl2br(c.address) : "",
    c.email ? esc(c.email) : "",
    c.phone ? esc(c.phone) : "",
    c.tin ? `TIN: ${esc(c.tin)}` : "",
  ].filter(Boolean).join("<br>");

  const rows = items.map((it, i) => `<tr><td class="n">${i + 1}</td><td>${nl2br(it.desc)}</td><td class="r">${it.qty}</td><td class="r">${money(it.price_sen)}</td><td class="r">${money(Math.round(it.qty * it.price_sen))}</td></tr>`).join("");

  let sums = `<tr><td>Subtotal</td><td class="r">${money(subtotal)}</td></tr>`;
  if (discount) sums += `<tr><td>Discount</td><td class="r">-${money(discount)}</td></tr>`;
  sums += `<tr class="tot"><td>Total (RM)</td><td class="r">${money(total)}</td></tr>`;
  if (!isInv && doc.deposit_pct > 0) {
    sums += `<tr><td>Deposit on acceptance (${doc.deposit_pct}%)</td><td class="r">${money(Math.round(total * doc.deposit_pct / 100))}</td></tr>`;
  }
  if (isInv) {
    const a = invoiceAmounts(doc);
    if (doc.invoice_type === "deposit") sums += `<tr><td>Deposit due now (${doc.deposit_pct}% of total)</td><td class="r">${money(a.bill)}</td></tr>`;
    if (doc.invoice_type === "balance") sums += `<tr><td>Less deposit received</td><td class="r">-${money(total - a.bill)}</td></tr>`;
    if (a.paid) sums += `<tr><td>${doc.paid_date && doc.paid_date < doc.issue_date ? "Advance received" : "Paid"}${doc.paid_date ? " (" + fmtDate(doc.paid_date) + ")" : ""}</td><td class="r">-${money(a.paid)}</td></tr>`;
    sums += `<tr class="due"><td>Amount due (RM)</td><td class="r">${money(a.balance)}</td></tr>`;
  }

  const pay = isInv ? `<section class="box"><h3>Payment details</h3><table class="kv">
      <tr><td>Bank</td><td>${esc(settings.bank_name)}</td></tr>
      <tr><td>Account name</td><td>${esc(settings.bank_account_name)}</td></tr>
      <tr><td>Account no.</td><td>${esc(settings.bank_account_no) || '<span class="muted">(to be advised)</span>'}</td></tr>
      <tr><td>Reference</td><td>${esc(doc.number)}</td></tr></table></section>` : "";
  const terms = fillTerms(doc.terms ?? (isInv ? settings.invoice_terms : settings.quote_terms), settings, doc);
  const stamp = doc.status === "paid" ? '<div class="stamp">PAID</div>' : doc.status === "void" ? '<div class="stamp void">VOID</div>' : "";
  const accepted = !isInv && doc.accepted_at ? `<p class="ok">Accepted${doc.accepted_name ? " by " + esc(doc.accepted_name) : ""} on ${esc(fmtDate(String(doc.accepted_at).slice(0, 10)))}.</p>` : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title || `${doc.number} | ${settings.biz_name}`)}</title>
<style>
${DOC_CSS}</style></head><body>
${extra}
<main class="paper">
<div class="top">
  <div>
    <div class="brand">${logoHtml(settings)}<b>${esc(settings.biz_name)}</b></div>
    <div class="from">${esc(settings.reg_no)}<br>${nl2br(settings.address)}<br>${esc(settings.email)} · ${esc(settings.phone)}<br>${esc(settings.website)}${settings.tin ? " · TIN " + esc(settings.tin) : ""}</div>
  </div>
  <div><h1>${heading}</h1><table class="meta">${meta.map(([k, v]) => `<tr><td>${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join("")}</table>${stamp}</div>
</div>
<div class="parties"><div><h3>${isInv ? "Bill to" : "Prepared for"}</h3>${billTo || '<span class="muted">-</span>'}</div></div>
${doc.title ? `<p class="subject">${esc(doc.title)}</p>` : ""}
<table class="items"><thead><tr><th>#</th><th>Description</th><th class="r">Qty</th><th class="r">Unit price (RM)</th><th class="r">Amount (RM)</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">No items</td></tr>'}</tbody></table>
<table class="sums">${sums}</table>
${doc.notes ? `<section class="box"><h3>Notes</h3>${nl2br(doc.notes)}</section>` : ""}
${pay}
${accepted}
<section class="terms"><h3>Terms</h3>${nl2br(terms)}<br>${esc(settings.sst_note)}</section>
<div class="foot"><span>This is a computer-generated document. No signature is required.</span><span>${esc(doc.number)}</span></div>
</main></body></html>`;
}

// 1234.50 RM -> "Ringgit Malaysia One Thousand Two Hundred Thirty-Four and Sen Fifty Only"
export function amountInWords(sen) {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen",
    "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const under1000 = n => {
    const h = Math.floor(n / 100), r = n % 100;
    const rest = r < 20 ? ones[r] : tens[Math.floor(r / 10)] + (r % 10 ? "-" + ones[r % 10] : "");
    return [h ? ones[h] + " Hundred" : "", rest].filter(Boolean).join(" ");
  };
  const words = n => {
    if (n === 0) return "Zero";
    const parts = [];
    for (const [size, name] of [[1e9, "Billion"], [1e6, "Million"], [1e3, "Thousand"], [1, ""]]) {
      const chunk = Math.floor(n / size) % 1000;
      if (chunk) parts.push(under1000(chunk) + (name ? " " + name : ""));
    }
    return parts.join(" ");
  };
  const total = Math.round(Number(sen) || 0);
  const rm = Math.floor(total / 100), cents = total % 100;
  return `Ringgit Malaysia ${words(rm)}${cents ? ` and Sen ${words(cents)}` : ""} Only`;
}

// An official receipt for one payment against an invoice.
export function renderReceipt(rc, invoice, client, settings, { extra = "", receivedToDate = null } = {}) {
  const c = client || {};
  const from = [c.company ? `<strong>${esc(c.company)}</strong>` : "", c.name ? (c.company ? `Attn: ${esc(c.name)}` : `<strong>${esc(c.name)}</strong>`) : "",
    c.address ? nl2br(c.address) : "", c.phone ? esc(c.phone) : "", c.email ? esc(c.email) : ""].filter(Boolean).join("<br>");
  const inv = invoice ? invoiceAmounts(invoice) : null;
  const toDate = receivedToDate ?? inv?.paid ?? rc.amount_sen;
  const billed = inv?.bill ?? rc.amount_sen;
  const stamp = rc.status === "void" ? '<div class="stamp void">VOID</div>' : '<div class="stamp">RECEIVED</div>';
  const rows = [
    ["Payment for", invoice ? `Invoice ${esc(invoice.number)}${invoice.title ? " – " + esc(invoice.title) : ""}` : "-"],
    ["Payment method", esc(rc.method || "Bank transfer")],
    ["Payment date", esc(fmtDate(rc.paid_date))],
    ...(rc.ref ? [["Reference", esc(rc.ref)]] : []),
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(rc.number)} | ${esc(settings.biz_name)}</title>
<style>
${DOC_CSS}
.amount{margin-top:22px;padding:16px 18px;border-radius:8px;background:var(--bg);display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap}
.amount b{font-size:24px;color:var(--teal)}.amount span{font-size:13px;color:#4A5D73}
@media print{.amount{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
${extra}
<main class="paper">
<div class="top">
  <div>
    <div class="brand">${logoHtml(settings)}<b>${esc(settings.biz_name)}</b></div>
    <div class="from">${esc(settings.reg_no)}<br>${nl2br(settings.address)}<br>${esc(settings.email)} · ${esc(settings.phone)}<br>${esc(settings.website)}${settings.tin ? " · TIN " + esc(settings.tin) : ""}</div>
  </div>
  <div><h1>OFFICIAL RECEIPT</h1><table class="meta"><tr><td>Receipt no.</td><td><b>${esc(rc.number)}</b></td></tr><tr><td>Date</td><td><b>${esc(fmtDate(String(rc.created_at || "").slice(0, 10)) || fmtDate(rc.paid_date))}</b></td></tr></table>${stamp}</div>
</div>
<div class="parties"><div><h3>Received from</h3>${from || '<span class="muted">-</span>'}</div></div>
<div class="amount"><div><h3>Amount received</h3><span>${esc(amountInWords(rc.amount_sen))}</span></div><b>RM ${money(rc.amount_sen)}</b></div>
<section class="box"><table class="kv">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table></section>
${invoice ? `<table class="sums"><tr><td>Invoice amount</td><td class="r">${money(billed)}</td></tr><tr><td>Received to date</td><td class="r">${money(toDate)}</td></tr><tr class="due"><td>Balance (RM)</td><td class="r">${money(Math.max(0, billed - toDate))}</td></tr></table>` : ""}
${rc.notes ? `<section class="box"><h3>Notes</h3>${nl2br(rc.notes)}</section>` : ""}
<section class="terms">Thank you for your payment. ${esc(settings.sst_note)}</section>
<div class="foot"><span>This is a computer-generated receipt. No signature is required.</span><span>${esc(rc.number)}</span></div>
</main></body></html>`;
}

// Expense categories for the books (roughly the lines of the Form B business income schedule).
// pct = share normally deductible; entertainment is usually only 50% deductible. Check with your tax agent.
export const EXPENSE_CATEGORIES = [
  { key: "software", en: "Software & subscriptions", zh: "软件与订阅", pct: 100 },
  { key: "registration", en: "Registration & licences (SSM etc.)", zh: "注册与执照（SSM 等）", pct: 100 },
  { key: "internet", en: "Phone & internet", zh: "电话与网络", pct: 100 },
  { key: "website", en: "Domain & hosting", zh: "域名与网站", pct: 100 },
  { key: "marketing", en: "Marketing & advertising", zh: "广告与推广", pct: 100 },
  { key: "transport", en: "Transport & travel", zh: "交通与出差", pct: 100 },
  { key: "professional", en: "Professional fees (accountant etc.)", zh: "专业服务费（会计等）", pct: 100 },
  { key: "bank", en: "Bank charges", zh: "银行手续费", pct: 100 },
  { key: "office", en: "Office supplies", zh: "办公用品", pct: 100 },
  { key: "training", en: "Training & books", zh: "培训与书籍", pct: 100 },
  { key: "entertainment", en: "Client entertainment", zh: "招待客户", pct: 50 },
  { key: "equipment", en: "Equipment (capital allowance)", zh: "设备（资本免税额）", pct: 100 },
  { key: "other", en: "Other", zh: "其他", pct: 100 },
];
export const categoryName = key => (EXPENSE_CATEGORIES.find(c => c.key === key) || { en: key }).en;
// Deductible part of one expense: nothing if a client reimbursed it (or will), otherwise amount × deductible %.
export const deductibleSen = e => (e.reimbursed === "no" ? Math.round(e.amount_sen * (e.deductible_pct ?? 100) / 100) : 0);
