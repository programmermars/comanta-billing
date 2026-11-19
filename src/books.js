// Books: money received, expenses and profit per month, for the owner and the tax return (Form B).
//   /admin/books?year=2026         dashboard
//   /admin/books/expense/new       add an expense   (POST /admin/books/expense/save)
//   /admin/books/expense/<id>      edit or delete
//   /admin/books.csv?year=2026     everything in one CSV for the accountant
// Income = payments table (date the money arrived). Expenses = expenses table.
// Expenses a client paid back are shown but not counted (not income, not deductible).
import { esc, money, toSen, isYmd, myToday, fmtDate, EXPENSE_CATEGORIES, categoryName, deductibleSen } from "./billing-core.js";
import { adminPage, page, go, clean, int, form } from "./billing.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const REIMB = { no: "No", to_bill: "To bill client", reimbursed: "Reimbursed by client" };
const rm = sen => `RM ${money(sen)}`;
// A receipt link opens directly; a plain file name is shown as text.
const fileLink = f => !f ? "" : /^https?:\/\//.test(f) ? `<a href="${esc(f)}" target="_blank" rel="noopener">View receipt</a>` : `<span class="note">${esc(f)}</span>`;


async function loadYear(env, year) {
  const like = `${year}-%`;
  const payments = (await env.DB.prepare(`SELECT p.*, d.number, COALESCE(c.company, c.name) AS client FROM payments p
      LEFT JOIN docs d ON d.id = p.invoice_id LEFT JOIN clients c ON c.id = d.client_id WHERE p.paid_date LIKE ? ORDER BY p.paid_date, p.id`).bind(like).all()).results;
  const expenses = (await env.DB.prepare(`SELECT e.*, COALESCE(c.company, c.name) AS client FROM expenses e LEFT JOIN clients c ON c.id = e.client_id
      WHERE e.spent_date LIKE ? ORDER BY e.spent_date, e.id`).bind(like).all()).results;
  return { payments, expenses };
}

async function dashboard(env, url) {
  const year = /^\d{4}$/.test(url.searchParams.get("year") || "") ? url.searchParams.get("year") : myToday().slice(0, 4);
  const { payments, expenses } = await loadYear(env, year);
  const unpaid = await env.DB.prepare(`SELECT COALESCE(SUM(COALESCE(bill_sen,total_sen) - paid_sen),0) AS s, COUNT(*) AS n FROM docs WHERE kind='invoice' AND status='sent'`).first();
  const income = payments.reduce((a, p) => a + p.amount_sen, 0);
  const deductible = expenses.reduce((a, e) => a + deductibleSen(e), 0);
  const reimbursed = expenses.filter(e => e.reimbursed === "reimbursed").reduce((a, e) => a + e.amount_sen, 0);
  const toBill = expenses.filter(e => e.reimbursed === "to_bill").reduce((a, e) => a + e.amount_sen, 0);

  const months = MONTHS.map((m, i) => {
    const mm = `${year}-${String(i + 1).padStart(2, "0")}`;
    const inc = payments.filter(p => p.paid_date.startsWith(mm)).reduce((a, p) => a + p.amount_sen, 0);
    const exp = expenses.filter(e => e.spent_date.startsWith(mm)).reduce((a, e) => a + deductibleSen(e), 0);
    return { m, inc, exp, net: inc - exp };
  });
  const byCat = EXPENSE_CATEGORIES.map(c => {
    const list = expenses.filter(e => e.category === c.key);
    return { name: c.en, count: list.length, paid: list.reduce((a, e) => a + e.amount_sen, 0), ded: list.reduce((a, e) => a + deductibleSen(e), 0) };
  }).filter(r => r.count);

  const yearLinks = [Number(year) - 1, Number(year), Number(year) + 1].map(y => `<a href="/admin/books?year=${y}"${String(y) === year ? " aria-current" : ""}>${y}</a>`).join("");
  const msg = { saved: "Expense saved.", deleted: "Expense deleted." }[url.searchParams.get("msg")];
  const expRows = expenses.slice().reverse().map(e => `<tr><td>${esc(fmtDate(e.spent_date))}</td><td><a href="/admin/books/expense/${e.id}">${esc(e.vendor)}</a><br><span class="note">${esc(e.description || "")}</span></td>
    <td>${esc(categoryName(e.category))}</td><td class="r">${money(e.amount_sen)}</td><td class="r">${money(deductibleSen(e))}</td>
    <td>${e.reimbursed === "no" ? (e.paid_from === "personal" ? '<span class="pill">Personal account</span>' : "") : `<span class="pill ${e.reimbursed === "reimbursed" ? "paid" : "sent"}">${esc(REIMB[e.reimbursed])}${e.client ? " · " + esc(e.client) : ""}</span>`}</td>
    <td>${fileLink(e.file)}</td></tr>`).join("");
  const { results: rcs } = await env.DB.prepare("SELECT id, number, invoice_id, amount_sen, paid_date FROM receipts WHERE status = 'issued'").all();
  const rcFor = p => rcs.find(r => r.invoice_id === p.invoice_id && r.paid_date === p.paid_date && r.amount_sen === p.amount_sen);
  const payRows = payments.slice().reverse().map(p => {
    const rc = rcFor(p);
    return `<tr><td>${esc(fmtDate(p.paid_date))}</td><td><a href="/admin/doc/${p.invoice_id}">${esc(p.number || "")}</a></td><td>${esc(p.client || "")}</td><td class="note">${esc(p.ref || "")}</td>
      <td>${rc ? `<a href="/admin/receipt/${rc.id}">${esc(rc.number)}</a>` : `<a class="note" href="/admin/doc/${p.invoice_id}">+ receipt</a>`}</td><td class="r">${money(p.amount_sen)}</td></tr>`;
  }).join("");

  return adminPage(`Books ${year}`, `<h1>Books ${esc(year)}</h1>
<div class="tabs">${yearLinks}<a href="/admin/books/expense/new" style="margin-left:auto;background:var(--teal);color:#fff;border-color:var(--teal)">+ Expense</a><a href="/admin/books.csv?year=${esc(year)}">Download CSV</a></div>
${msg ? `<div class="flash">${msg}</div>` : ""}
<div class="cards">
<div class="card"><span>Money received</span><b>${rm(income)}</b></div>
<div class="card"><span>Deductible expenses</span><b>${rm(deductible)}</b></div>
<div class="card"><span>Profit (received − expenses)</span><b>${rm(income - deductible)}</b></div>
<div class="card"><span>Unpaid invoices now (${unpaid.n})</span><b>${rm(unpaid.s)}</b></div>
</div>
<p class="note">Reimbursed by clients this year: ${rm(reimbursed)} (left out of both income and expenses)${toBill ? ` · still to bill clients: <b>${rm(toBill)}</b>` : ""}.
Profit here is cash received minus deductible expenses; your tax agent may still adjust it (e.g. capital allowance for equipment).</p>

<h2>By month</h2>
<table class="list"><tr><th>Month</th><th class="r">Received (RM)</th><th class="r">Expenses (RM)</th><th class="r">Profit (RM)</th></tr>
${months.filter(r => r.inc || r.exp).map(r => `<tr><td>${r.m} ${esc(year)}</td><td class="r">${r.inc ? money(r.inc) : "-"}</td><td class="r">${r.exp ? money(r.exp) : "-"}</td><td class="r">${money(r.net)}</td></tr>`).join("") || '<tr><td colspan="4" class="note">Nothing recorded this year.</td></tr>'}
<tr><td><b>Total</b></td><td class="r"><b>${money(income)}</b></td><td class="r"><b>${money(deductible)}</b></td><td class="r"><b>${money(income - deductible)}</b></td></tr></table>

${byCat.length ? `<h2>Expenses by category</h2><table class="list"><tr><th>Category</th><th class="r">Items</th><th class="r">Paid (RM)</th><th class="r">Deductible (RM)</th></tr>
${byCat.map(r => `<tr><td>${esc(r.name)}</td><td class="r">${r.count}</td><td class="r">${money(r.paid)}</td><td class="r">${money(r.ded)}</td></tr>`).join("")}</table>` : ""}

<h2>Expenses</h2>
<table class="list"><tr><th>Date</th><th>Vendor</th><th>Category</th><th class="r">Paid (RM)</th><th class="r">Deductible (RM)</th><th></th><th>Receipt</th></tr>
${expRows || '<tr><td colspan="7" class="note">No expenses yet. Press + Expense.</td></tr>'}</table>

<h2>Money received</h2>
<table class="list"><tr><th>Date</th><th>Invoice</th><th>Client</th><th>Reference</th><th>Receipt</th><th class="r">Amount (RM)</th></tr>
${payRows || '<tr><td colspan="6" class="note">No payments recorded yet.</td></tr>'}</table>`);
}

async function expenseForm(env, id) {
  const e = id ? await env.DB.prepare("SELECT * FROM expenses WHERE id = ?").bind(id).first() : null;
  if (id && !e) return go("/admin/books");
  const { results: clients } = await env.DB.prepare("SELECT id, COALESCE(company, name) AS label FROM clients ORDER BY label").all();
  const v = x => esc(x ?? "");
  const cat = e?.category || "software";
  return adminPage(e ? "Edit expense" : "New expense", `<h1>${e ? "Edit expense" : "New expense"}</h1>
<form method="post" action="/admin/books/expense/save"><input type="hidden" name="id" value="${e?.id || ""}">
<fieldset><legend>Expense</legend><div class="grid">
<div><label>Date paid</label><input name="spent_date" type="date" value="${v(e?.spent_date || myToday())}" required></div>
<div><label>Paid to (vendor)</label><input name="vendor" value="${v(e?.vendor)}" required placeholder="e.g. SSM, your phone company, a software vendor"></div>
<div><label>Amount (RM)</label><input name="amount" type="number" step="0.01" min="0" value="${e ? (e.amount_sen / 100).toFixed(2) : ""}" required></div>
<div><label>Category</label><select name="category" onchange="const o=this.selectedOptions[0];document.querySelector('[name=deductible_pct]').value=o.dataset.pct">
${EXPENSE_CATEGORIES.map(c => `<option value="${c.key}" data-pct="${c.pct}"${c.key === cat ? " selected" : ""}>${esc(c.en)} · ${esc(c.zh)}</option>`).join("")}</select></div>
<div><label>Deductible (%)</label><input name="deductible_pct" type="number" min="0" max="100" value="${v(e?.deductible_pct ?? 100)}"></div>
<div><label>Paid from</label><select name="paid_from"><option value="business"${e?.paid_from !== "personal" ? " selected" : ""}>Business account</option><option value="personal"${e?.paid_from === "personal" ? " selected" : ""}>Personal account / card</option></select></div>
</div>
<label>What for</label><input name="description" value="${v(e?.description)}" placeholder="e.g. API credit, SSM business profile">
</fieldset>
<fieldset><legend>Paid back by a client?</legend><div class="grid">
<div><label>Reimbursed</label><select name="reimbursed">${Object.entries(REIMB).map(([k, l]) => `<option value="${k}"${(e?.reimbursed || "no") === k ? " selected" : ""}>${l}</option>`).join("")}</select></div>
<div><label>Client</label><select name="client_id"><option value="">-</option>${clients.map(c => `<option value="${c.id}"${c.id === e?.client_id ? " selected" : ""}>${esc(c.label)}</option>`).join("")}</select></div>
<div><label>Date paid back</label><input name="reimbursed_date" type="date" value="${v(e?.reimbursed_date)}"></div>
</div><p class="note">A reimbursed expense is not deductible and the money back is not income (both are left out of the profit).</p></fieldset>
<fieldset><legend>Proof</legend>
<label>Receipt file or link (optional)</label><input name="file" value="${v(e?.file)}" placeholder="e.g. 2026-11-18_Vendor_invoice.pdf or a Drive link">
<label>Notes</label><textarea name="notes">${v(e?.notes)}</textarea></fieldset>
<button class="p">Save expense</button> <a class="btn" href="/admin/books">Cancel</a>
</form>
${e ? `<form method="post" action="/admin/books/expense/${e.id}/delete" onsubmit="return confirm('Delete this expense?')" style="margin-top:14px"><button class="danger">Delete</button></form>` : ""}`);
}

async function saveExpense(request, env) {
  const d = await form(request);
  const amount = toSen(d.amount);
  const vendor = clean(d.vendor, 160);
  if (!vendor || amount <= 0 || !isYmd(d.spent_date)) return page(`<p>Please fill in the date, vendor and amount. <a href="javascript:history.back()">Go back</a></p>`, 400);
  const cat = EXPENSE_CATEGORIES.some(c => c.key === d.category) ? d.category : "other";
  const reimb = ["no", "to_bill", "reimbursed"].includes(d.reimbursed) ? d.reimbursed : "no";
  const vals = [d.spent_date, vendor, clean(d.description, 300), cat, amount, d.paid_from === "personal" ? "personal" : "business", reimb,
    int(d.client_id) || null, isYmd(d.reimbursed_date) ? d.reimbursed_date : null, Math.max(0, Math.min(100, int(d.deductible_pct))), clean(d.file, 300) || null, clean(d.notes, 2000) || null];
  const id = int(d.id);
  if (id) {
    await env.DB.prepare(`UPDATE expenses SET spent_date=?, vendor=?, description=?, category=?, amount_sen=?, paid_from=?, reimbursed=?, client_id=?, reimbursed_date=?,
        deductible_pct=?, file=?, notes=?, updated_at=datetime('now') WHERE id=?`).bind(...vals, id).run();
  } else {
    await env.DB.prepare(`INSERT INTO expenses (spent_date, vendor, description, category, amount_sen, paid_from, reimbursed, client_id, reimbursed_date, deductible_pct, file, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...vals).run();
  }
  return go(`/admin/books?year=${d.spent_date.slice(0, 4)}&msg=saved`);
}

async function csv(env, url) {
  const year = /^\d{4}$/.test(url.searchParams.get("year") || "") ? url.searchParams.get("year") : myToday().slice(0, 4);
  const { payments, expenses } = await loadYear(env, year);
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["type", "date", "party", "description", "category", "amount_rm", "deductible_rm", "paid_from", "reimbursed", "reference_or_file"].join(",")];
  for (const p of payments) lines.push(["income", p.paid_date, p.client, `Payment for ${p.number}`, "", (p.amount_sen / 100).toFixed(2), "", "", "", p.ref].map(q).join(","));
  for (const e of expenses) lines.push(["expense", e.spent_date, e.vendor, e.description, categoryName(e.category), (e.amount_sen / 100).toFixed(2),
    (deductibleSen(e) / 100).toFixed(2), e.paid_from, REIMB[e.reimbursed] + (e.client ? ` (${e.client})` : ""), e.file].map(q).join(","));
  return new Response("﻿" + lines.join("\r\n") + "\r\n", { headers: {
    "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="books-${year}.csv"`, "cache-control": "no-store" } });
}

// Called by the billing router after the admin login check.
export async function handleBooks(request, env, url) {
  const p = url.pathname;
  const post = request.method === "POST";
  if (p === "/admin/books" || p === "/admin/books/") return dashboard(env, url);
  if (p === "/admin/books.csv") return csv(env, url);
  if (p === "/admin/books/expense/new") return expenseForm(env, 0);
  if (p === "/admin/books/expense/save" && post) return saveExpense(request, env);
  const m = p.match(/^\/admin\/books\/expense\/(\d+)(\/delete)?$/);
  if (m) {
    if (m[2] && post) {
      const row = await env.DB.prepare("SELECT spent_date FROM expenses WHERE id = ?").bind(int(m[1])).first();
      await env.DB.prepare("DELETE FROM expenses WHERE id = ?").bind(int(m[1])).run();
      return go(`/admin/books?year=${(row?.spent_date || myToday()).slice(0, 4)}&msg=deleted`);
    }
    return expenseForm(env, int(m[1]));
  }
  return null;
}
