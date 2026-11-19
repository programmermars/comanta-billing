// Quotations and invoices.
//   /admin/...      owner-only pages (login with a one-time code emailed to the owner)
//   /d/<token>      the client's view of one document (print / save as PDF, accept a quotation)
// Data: D1 tables billing_settings, clients, docs, counters, admin_codes, admin_sessions (billing.sql).
// The local tool tools/billing.mjs works on the same tables through wrangler, so Claude can issue documents too.
import { notify } from "./notify.js";
import { emailBackup } from "./backup.js";
import { handleBooks } from "./books.js";
import {
  CATALOG, STATUS, esc, money, toSen, myToday, addDays, isYmd, fmtDate, calc, invoiceAmounts,
  randomToken, formatNumber, counterSql, renderDoc, renderReceipt, LOGO_SVG, nextMonthText,
} from "./billing-core.js";

const COOKIE = "cm_admin";
const SESSION_DAYS = 30;
const CODE_MINUTES = 10;

const headers = extra => ({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", ...extra });
export const page = (body, status = 200, extra = {}) => new Response(body, { status, headers: headers(extra) });
export const go = (path, extra = {}) => new Response(null, { status: 303, headers: { location: path, "cache-control": "no-store", ...extra } });
export const clean = (v, max) => (typeof v === "string" ? v.replace(/\r/g, "").trim().slice(0, max) : "");
export const int = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Public address of this app, e.g. https://billing.example.com (SITE_URL in wrangler.jsonc).
export const siteUrl = env => String(env.SITE_URL || "").replace(/\/+$/, "");
const isLocal = env => String(env.LOCAL_DEV || "") === "1";
function sameOrigin(request, env) {
  const o = request.headers.get("origin");
  if (o && o === siteUrl(env)) return true;
  // wrangler dev rewrites Origin to the route's host over http.
  return isLocal(env) && /^http:\/\//.test(o || "");
}
export async function form(request) {
  const f = await request.formData();
  const out = {};
  for (const [k, v] of f.entries()) {
    if (k.endsWith("[]")) (out[k.slice(0, -2)] ||= []).push(String(v));
    else out[k] = String(v);
  }
  return out;
}

export async function getSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM billing_settings").all();
  return Object.fromEntries(results.map(r => [r.key, r.value]));
}

// ---------- login ----------
function readCookie(request) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : "";
}
async function isAdmin(request, env) {
  const t = readCookie(request);
  if (!t) return false;
  const row = await env.DB.prepare("SELECT 1 FROM admin_sessions WHERE token_hash = ? AND expires_at > datetime('now')").bind(await sha256(t)).first();
  return !!row;
}
const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

const loginShell = (inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Admin login | Billing</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F5F8FB;color:#0F2A4A;font:15px/1.6 Arial,sans-serif}
.card{background:#fff;border:1px solid #E3E8EF;border-radius:12px;padding:32px;width:min(380px,92vw)}
h1{font-size:20px;margin:12px 0 6px}p{margin:0 0 16px;color:#4A5D73}
input{width:100%;font:600 22px Arial;letter-spacing:.3em;text-align:center;padding:10px;border:1px solid #CBD5E1;border-radius:8px;margin-bottom:12px}
button{width:100%;font:600 15px Arial;background:#0B7A75;color:#fff;border:0;border-radius:8px;padding:11px;cursor:pointer}
.link{background:none;color:#0B7A75;padding:6px;margin-top:8px}.err{color:#B42318}.dev{background:#FFF7E6;padding:8px;border-radius:6px}</style></head>
<body><div class="card">${LOGO_SVG}${inner}</div></body></html>`;

function loginPage(msg = "", sent = false, devCode = "") {
  if (!sent) return page(loginShell(`<h1>Billing admin</h1><p>We will email a 6-digit login code to the owner's email address.</p>${msg ? `<p class="err">${esc(msg)}</p>` : ""}
<form method="post" action="/admin/login/send"><button>Email me a login code</button></form>`));
  return page(loginShell(`<h1>Enter your code</h1><p>Check your email for the login code. It works for ${CODE_MINUTES} minutes.</p>${msg ? `<p class="err">${esc(msg)}</p>` : ""}
${devCode ? `<p class="dev">Local test only. Code: <b>${devCode}</b></p>` : ""}
<form method="post" action="/admin/login/verify"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus><button>Log in</button></form>
<form method="post" action="/admin/login/send"><button class="link">Send a new code</button></form>`));
}

async function sendCode(request, env, ctx) {
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_codes WHERE created_at > datetime('now','-1 hour')").first();
  if (recent.n >= 5) return loginPage("Too many codes in the last hour. Please wait and try again.");
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  const code = String(n[0] % 1000000).padStart(6, "0");
  await env.DB.prepare("UPDATE admin_codes SET used = 1 WHERE used = 0").run();
  await env.DB.prepare("INSERT INTO admin_codes (code_hash) VALUES (?)").bind(await sha256(code)).run();
  if (isLocal(env)) return loginPage("", true, code);
  ctx.waitUntil(notify(env, `Admin login code: ${code}`,
    `Your billing admin login code is ${code}\n\nIt works for ${CODE_MINUTES} minutes. If you did not ask for it, ignore this email: nobody can log in without the code.`,
    "Billing").catch(err => console.error("code email failed", err)));
  return loginPage("", true);
}

async function verifyCode(request, env) {
  const data = await form(request);
  const code = clean(data.code, 6);
  const row = await env.DB.prepare(`SELECT id, code_hash, tries FROM admin_codes WHERE used = 0 AND created_at > datetime('now','-${CODE_MINUTES} minutes') ORDER BY id DESC LIMIT 1`).first();
  if (!row) return loginPage("That code has expired. Please ask for a new one.");
  if (row.tries >= 5) {
    await env.DB.prepare("UPDATE admin_codes SET used = 1 WHERE id = ?").bind(row.id).run();
    return loginPage("Too many wrong tries. Please ask for a new code.");
  }
  if ((await sha256(code)) !== row.code_hash) {
    await env.DB.prepare("UPDATE admin_codes SET tries = tries + 1 WHERE id = ?").bind(row.id).run();
    return loginPage("Wrong code. Please try again.", true);
  }
  await env.DB.prepare("UPDATE admin_codes SET used = 1 WHERE id = ?").bind(row.id).run();
  const token = randomToken() + randomToken();
  await env.DB.prepare(`INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, datetime('now','+${SESSION_DAYS} days'))`).bind(await sha256(token)).run();
  await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at < datetime('now')").run();
  return go("/admin", { "set-cookie": cookie(token, SESSION_DAYS * 86400) });
}

async function logout(request, env) {
  const t = readCookie(request);
  if (t) await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(await sha256(t)).run();
  return go("/admin/login", { "set-cookie": cookie("", 0) });
}

// ---------- admin layout ----------
const ADMIN_CSS = `:root{--navy:#0F2A4A;--teal:#0B7A75;--line:#E3E8EF;--muted:#6B7C90;--bg:#F5F8FB}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--navy);font:14px/1.55 Arial,Helvetica,sans-serif}
header{background:#fff;border-bottom:1px solid var(--line)}.hd{max-width:1100px;margin:0 auto;padding:10px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.hd b{font-size:16px;letter-spacing:.05em;margin-right:auto;display:flex;gap:8px;align-items:center}.hd a{color:var(--navy);text-decoration:none;font-weight:600}.hd a:hover{color:var(--teal)}
main{max-width:1100px;margin:0 auto;padding:20px 16px 60px}h1{font-size:22px;margin:0 0 16px}h2{font-size:16px;margin:28px 0 10px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card span{display:block;color:var(--muted);font-size:12.5px}.card b{font-size:20px}
table.list{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.list th{text-align:left;font-size:12px;color:var(--muted);padding:9px 10px;border-bottom:1px solid var(--line);background:#FAFBFC}.list td{padding:9px 10px;border-bottom:1px solid var(--line)}
.list a{color:var(--teal);font-weight:600}.r{text-align:right;white-space:nowrap}
.pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;background:#EEF2F6}.pill.paid,.pill.accepted,.pill.invoiced{background:#E6F5F4;color:var(--teal)}.pill.sent{background:#FFF7E6;color:#9A6700}.pill.void,.pill.declined{background:#FDECEC;color:#B42318}
.btn,button{display:inline-block;font:600 14px Arial;border:1px solid var(--teal);background:#fff;color:var(--teal);border-radius:8px;padding:8px 14px;cursor:pointer;text-decoration:none}
.btn.p,button.p{background:var(--teal);color:#fff}button.danger{border-color:#B42318;color:#B42318}
.tabs{display:flex;gap:8px;margin:8px 0 12px;flex-wrap:wrap}.tabs a{padding:6px 12px;border-radius:999px;text-decoration:none;color:var(--navy);background:#fff;border:1px solid var(--line)}.tabs a[aria-current]{background:var(--navy);color:#fff}
fieldset{border:1px solid var(--line);border-radius:10px;background:#fff;padding:14px 16px;margin:0 0 14px}legend{font-weight:700;padding:0 6px}
label{display:block;font-size:12.5px;color:var(--muted);margin:8px 0 3px}input,select,textarea{width:100%;font:14px Arial;padding:8px 10px;border:1px solid #CBD5E1;border-radius:7px;background:#fff;color:var(--navy)}
textarea{min-height:70px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0 14px}
.items-edit{width:100%;border-collapse:collapse}.items-edit td{padding:4px;vertical-align:top}.items-edit th{text-align:left;font-size:12px;color:var(--muted);padding:4px}
.items-edit td:nth-child(2),.items-edit td:nth-child(3){width:130px}.items-edit td:last-child{width:40px}
.note{color:var(--muted);font-size:12.5px}.flash{background:#E6F5F4;border:1px solid #B7E3E0;padding:10px 14px;border-radius:8px;margin-bottom:14px}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}.actions form{display:inline}
.share{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.share input{max-width:460px}`;

export function adminPage(title, body) {
  return page(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} | Billing admin</title><style>${ADMIN_CSS}</style></head><body>
${adminNav()}
<main>${body}</main></body></html>`);
}

// The top bar on every owner page (also on single documents and receipts), so Home is always one click away.
export const adminNav = () => `<header class="noprint"><div class="hd"><a href="/admin" style="margin-right:auto;display:flex;gap:8px;align-items:center;font-size:16px;letter-spacing:.05em">${LOGO_SVG.replace('width="40" height="40"', 'width="26" height="26"')}Billing admin</a>
<a href="/admin">🏠 Home</a><a href="/admin/new?kind=quote">+ Quote</a><a href="/admin/new?kind=invoice">+ Invoice</a><a href="/admin/?kind=receipt">Receipts</a><a href="/admin/books">Books</a><a href="/admin/settings">Settings</a>
<form method="post" action="/admin/logout" style="display:inline"><button>Log out</button></form></div></header>`;

const pill = (kind, status) => `<span class="pill ${esc(status)}">${esc(STATUS[kind]?.[status] || status)}</span>`;

// ---------- dashboard ----------
async function dashboard(env, url) {
  const kind = ["quote", "invoice", "receipt"].includes(url.searchParams.get("kind")) ? url.searchParams.get("kind") : "";
  if (kind === "receipt") return receiptList(env);
  const where = kind ? "WHERE d.kind = ?" : "";
  const stmt = env.DB.prepare(`SELECT d.*, c.company, c.name AS cname FROM docs d LEFT JOIN clients c ON c.id = d.client_id ${where} ORDER BY d.id DESC LIMIT 200`);
  const { results: docs } = await (kind ? stmt.bind(kind) : stmt).all();
  const year = myToday().slice(0, 4);
  const sums = await env.DB.prepare(`SELECT
      COALESCE(SUM(CASE WHEN kind='invoice' AND status='sent' THEN COALESCE(bill_sen,total_sen) - paid_sen END),0) AS unpaid,
      COALESCE(SUM(CASE WHEN kind='invoice' AND status!='void' AND substr(COALESCE(paid_date,''),1,4)=? THEN paid_sen END),0) AS paid_year,
      COALESCE(SUM(CASE WHEN kind='quote' AND status IN ('sent','accepted') THEN total_sen END),0) AS open_quotes
    FROM docs`).bind(year).first();
  let orders = [];
  try {
    orders = (await env.DB.prepare("SELECT id, created_at, kind, item, price, name, company FROM orders WHERE status = 'new' ORDER BY id DESC LIMIT 10").all()).results;
  } catch { /* orders table missing locally */ }

  const rows = docs.map(d => {
    const amount = d.kind === "invoice" ? invoiceAmounts(d).bill : d.total_sen;
    return `<tr><td><a href="/admin/doc/${d.id}">${esc(d.number)}</a></td><td>${esc(d.company || d.cname || "-")}</td><td>${esc(d.title || "")}</td><td>${esc(fmtDate(d.issue_date))}</td><td class="r">${money(amount)}</td><td>${pill(d.kind, d.status)}</td></tr>`;
  }).join("");
  const tab = (k, label) => `<a href="/admin${k ? "?kind=" + k : ""}"${k === kind ? " aria-current" : ""}>${label}</a>`;
  const orderRows = orders.map(o => `<tr><td>#${o.id}</td><td>${esc(o.company || o.name)}</td><td>${esc(o.item)}</td><td>${esc(o.price)}</td><td>${esc(o.kind)}</td><td><a href="/admin/new?kind=quote&order=${o.id}">Make quote</a></td></tr>`).join("");
  return adminPage("Documents", `<h1>Quotations &amp; invoices</h1>
<div class="cards"><div class="card"><span>Unpaid invoices</span><b>RM ${money(sums.unpaid)}</b></div><div class="card"><span>Received in ${year}</span><b>RM ${money(sums.paid_year)}</b></div><div class="card"><span>Open quotations</span><b>RM ${money(sums.open_quotes)}</b></div></div>
${orders.length ? `<h2>New requests from the website</h2><table class="list"><tr><th>Order</th><th>Client</th><th>Item</th><th>Price</th><th>Type</th><th></th></tr>${orderRows}</table>` : ""}
<h2>Documents</h2><div class="tabs">${tab("", "All")}${tab("quote", "Quotations")}${tab("invoice", "Invoices")}${tab("receipt", "Receipts")}</div>
<table class="list"><tr><th>No.</th><th>Client</th><th>Subject</th><th>Date</th><th class="r">Amount (RM)</th><th>Status</th></tr>${rows || '<tr><td colspan="6" class="note">Nothing yet. Start with + Quote.</td></tr>'}</table>`);
}

async function receiptList(env) {
  const { results } = await env.DB.prepare("SELECT r.*, d.number AS inv, COALESCE(c.company, c.name) AS client FROM receipts r LEFT JOIN docs d ON d.id = r.invoice_id LEFT JOIN clients c ON c.id = r.client_id ORDER BY r.id DESC LIMIT 200").all();
  const rows = results.map(r => `<tr><td><a href="/admin/receipt/${r.id}">${esc(r.number)}</a></td><td>${esc(r.client || "-")}</td><td>${esc(r.inv || "")}</td><td>${esc(fmtDate(r.paid_date))}</td><td class="r">${money(r.amount_sen)}</td><td>${pill("receipt", r.status)}</td></tr>`).join("");
  return adminPage("Receipts", `<h1>Quotations &amp; invoices</h1><div class="tabs"><a href="/admin">All</a><a href="/admin?kind=quote">Quotations</a><a href="/admin?kind=invoice">Invoices</a><a href="/admin?kind=receipt" aria-current>Receipts</a></div>
<table class="list"><tr><th>No.</th><th>Client</th><th>Invoice</th><th>Paid on</th><th class="r">Amount (RM)</th><th>Status</th></tr>${rows || '<tr><td colspan="6" class="note">No receipts yet. Open a paid invoice and press “Issue receipt”.</td></tr>'}</table>`);
}

// ---------- create / edit ----------
async function editForm(env, url, doc = null) {
  const s = await getSettings(env);
  const kind = doc ? doc.kind : (url.searchParams.get("kind") === "invoice" ? "invoice" : "quote");
  const { results: clients } = await env.DB.prepare("SELECT * FROM clients ORDER BY COALESCE(company, name) LIMIT 500").all();
  let client = doc ? clients.find(c => c.id === doc.client_id) || {} : {};
  let items = doc ? JSON.parse(doc.items) : [];
  let orderId = doc?.order_id || "";
  let title = doc?.title || "";
  let notes = doc?.notes || "";
  const fromOrder = !doc && int(url.searchParams.get("order"));
  if (fromOrder) {
    const o = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(fromOrder).first();
    if (o) {
      orderId = o.id;
      client = { name: o.name, company: o.company, email: o.email };
      items = [{ desc: o.item, qty: 1, price_sen: toSen(o.price) }];
      notes = o.notes ? `Request notes: ${o.notes}` : "";
      title = o.item;
    }
  }
  if (!items.length) items = [{ desc: "", qty: 1, price_sen: 0 }];
  const today = myToday();
  const issue = doc?.issue_date || today;
  const end = doc?.end_date || addDays(today, kind === "invoice" ? s.invoice_due_days : s.quote_valid_days);
  const v = (x) => esc(x ?? "");
  const itemRow = it => `<tr><td><textarea name="desc[]" rows="2" list="catalog" required>${v(it.desc)}</textarea></td><td><input name="qty[]" type="number" step="0.01" min="0" value="${v(it.qty)}"></td><td><input name="price[]" type="number" step="0.01" value="${it.price_sen ? (it.price_sen / 100).toFixed(2) : ""}" placeholder="0.00"></td><td><button type="button" onclick="this.closest('tr').remove()" title="Remove">✕</button></td></tr>`;
  const clientOpts = clients.map(c => `<option value="${c.id}"${c.id === client.id ? " selected" : ""}>${esc(c.company || c.name)}${c.company && c.name ? " (" + esc(c.name) + ")" : ""}</option>`).join("");
  const label = kind === "invoice" ? "invoice" : "quotation";
  return adminPage(doc ? `Edit ${doc.number}` : `New ${label}`, `<h1>${doc ? `Edit ${esc(doc.number)}` : `New ${label}`}</h1>
<form method="post" action="/admin/save">
<input type="hidden" name="id" value="${doc?.id || ""}"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="order_id" value="${v(orderId)}">
<fieldset><legend>Client</legend>
<label>Existing client</label><select name="client_id" onchange="fillClient(this.value)"><option value="">New client</option>${clientOpts}</select>
<div class="grid">
<div><label>Company</label><input name="c_company" value="${v(client.company)}"></div>
<div><label>Contact person</label><input name="c_name" value="${v(client.name)}"></div>
<div><label>Email</label><input name="c_email" type="email" value="${v(client.email)}"></div>
<div><label>Phone</label><input name="c_phone" value="${v(client.phone)}"></div>
<div><label>Company reg. no. (SSM)</label><input name="c_reg_no" value="${v(client.reg_no)}"></div>
<div><label>Client TIN (only if they need e-Invoice)</label><input name="c_tin" value="${v(client.tin)}"></div>
</div><label>Address</label><textarea name="c_address" rows="2">${v(client.address)}</textarea>
</fieldset>
<fieldset><legend>Document</legend><div class="grid">
<div><label>Subject (optional)</label><input name="title" value="${v(title)}" placeholder="e.g. Invoice-to-Excel automation for ABC Trading"></div>
<div><label>Date</label><input name="issue_date" type="date" value="${v(issue)}" required></div>
<div><label>${kind === "invoice" ? "Due date" : "Valid until"}</label><input name="end_date" type="date" value="${v(end)}"></div>
${kind === "quote" ? `<div><label>Deposit on acceptance (%)</label><input name="deposit_pct" type="number" min="0" max="100" value="${v(doc ? doc.deposit_pct : s.deposit_pct)}"></div>` : ""}
</div></fieldset>
<fieldset><legend>Items</legend>
<table class="items-edit"><thead><tr><th>Description (type to pick from the price list)</th><th>Qty</th><th>Unit price (RM)</th><th></th></tr></thead><tbody id="rows">${items.map(itemRow).join("")}</tbody></table>
<button type="button" onclick="addRow()">+ Add item</button>
<datalist id="catalog">${CATALOG.map(c => `<option value="${esc(c.desc)}">RM ${c.price.toLocaleString("en-MY")}</option>`).join("")}</datalist>
<div class="grid"><div><label>Discount (RM)</label><input name="discount" type="number" step="0.01" min="0" value="${doc?.discount_sen ? (doc.discount_sen / 100).toFixed(2) : ""}"></div></div>
<p class="note">Picking a price-list item fills in its usual price; you can change it.</p>
</fieldset>
<fieldset><legend>Notes &amp; terms</legend>
<label>Notes shown on the document (optional)</label><textarea name="notes">${v(notes)}</textarea>
<label>Terms (leave empty to use the standard terms from Settings)</label><textarea name="terms" rows="5">${v(doc?.terms)}</textarea>
</fieldset>
<button class="p">${doc ? "Save changes" : `Create ${label}`}</button> <a class="btn" href="${doc ? "/admin/doc/" + doc.id : "/admin"}">Cancel</a>
</form>
<template id="rowtpl">${itemRow({ desc: "", qty: 1, price_sen: 0 })}</template>
<script>
const CATALOG=${JSON.stringify(CATALOG)};const CLIENTS=${JSON.stringify(clients)};
function addRow(){document.getElementById('rows').insertAdjacentHTML('beforeend',document.getElementById('rowtpl').innerHTML)}
document.addEventListener('change',e=>{if(e.target.name==='desc[]'){const c=CATALOG.find(x=>x.desc===e.target.value.trim());const p=e.target.closest('tr').querySelector('[name="price[]"]');if(c&&!Number(p.value))p.value=c.price.toFixed(2)}});
function fillClient(id){const c=CLIENTS.find(x=>String(x.id)===id)||{};for(const k of ['company','name','email','phone','reg_no','tin','address']){const el=document.querySelector('[name="c_'+k+'"]');if(el)el.value=c[k]||''}}
</script>`);
}

async function upsertClient(env, d) {
  const c = {
    name: clean(d.c_name, 160), company: clean(d.c_company, 200), email: clean(d.c_email, 200), phone: clean(d.c_phone, 60),
    address: clean(d.c_address, 500), reg_no: clean(d.c_reg_no, 80), tin: clean(d.c_tin, 40),
  };
  if (!c.name && !c.company) return null;
  if (!c.name) c.name = c.company;
  const id = int(d.client_id);
  if (id) {
    await env.DB.prepare("UPDATE clients SET name=?, company=?, email=?, phone=?, address=?, reg_no=?, tin=? WHERE id=?")
      .bind(c.name, c.company, c.email, c.phone, c.address, c.reg_no, c.tin, id).run();
    return id;
  }
  const r = await env.DB.prepare("INSERT INTO clients (name, company, email, phone, address, reg_no, tin) VALUES (?,?,?,?,?,?,?)")
    .bind(c.name, c.company, c.email, c.phone, c.address, c.reg_no, c.tin).run();
  return r.meta.last_row_id;
}

export async function nextNumber(env, kind, issueDate) {
  const year = String(issueDate).slice(0, 4);
  const row = await env.DB.prepare(counterSql(kind, year)).first();
  const pre = (await env.DB.prepare("SELECT value FROM billing_settings WHERE key = 'number_prefix'").first())?.value || "";
  return formatNumber(kind, year, row.value, pre);
}

async function saveDoc(request, env) {
  const d = await form(request);
  const s = await getSettings(env);
  const id = int(d.id);
  const existing = id ? await env.DB.prepare("SELECT * FROM docs WHERE id = ?").bind(id).first() : null;
  if (id && !existing) return go("/admin");
  if (existing && (existing.status === "paid" || existing.status === "void" || existing.status === "invoiced")) return go(`/admin/doc/${id}?msg=locked`);
  const kind = existing ? existing.kind : (d.kind === "invoice" ? "invoice" : "quote");
  const raw = (d.desc || []).map((desc, i) => ({ desc, qty: (d.qty || [])[i], price_sen: toSen((d.price || [])[i]) }));
  const { items, total, discount } = calc(raw, toSen(d.discount));
  if (!items.length) return page(`<p>Please add at least one item. <a href="javascript:history.back()">Go back</a></p>`, 400);
  const issue = isYmd(d.issue_date) ? d.issue_date : myToday();
  const end = isYmd(d.end_date) ? d.end_date : addDays(issue, kind === "invoice" ? s.invoice_due_days : s.quote_valid_days);
  const clientId = await upsertClient(env, d);
  const depositPct = kind === "quote" ? Math.max(0, Math.min(100, int(d.deposit_pct))) : (existing?.deposit_pct || 0);
  const fields = [clientId, clean(d.title, 200), issue, end, JSON.stringify(items), discount, total, depositPct, clean(d.notes, 3000), clean(d.terms, 4000) || null];

  if (existing) {
    // A deposit/balance invoice keeps its billed share in step with the new total.
    let bill = existing.bill_sen;
    if (kind === "invoice" && (existing.invoice_type || "full") === "full") bill = total;
    await env.DB.prepare("UPDATE docs SET client_id=?, title=?, issue_date=?, end_date=?, items=?, discount_sen=?, total_sen=?, deposit_pct=?, notes=?, terms=?, bill_sen=?, updated_at=datetime('now') WHERE id=?")
      .bind(...fields, bill, id).run();
    return go(`/admin/doc/${id}?msg=saved`);
  }
  const number = await nextNumber(env, kind, issue);
  const r = await env.DB.prepare(`INSERT INTO docs (client_id, title, issue_date, end_date, items, discount_sen, total_sen, deposit_pct, notes, terms, kind, number, token, status, invoice_type, bill_sen, order_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?)`)
    .bind(...fields, kind, number, randomToken(), kind === "invoice" ? "full" : null, kind === "invoice" ? total : null, int(d.order_id) || null).run();
  if (int(d.order_id)) await env.DB.prepare("UPDATE orders SET status = 'quoted' WHERE id = ? AND status = 'new'").bind(int(d.order_id)).run().catch(() => {});
  return go(`/admin/doc/${r.meta.last_row_id}?msg=created`);
}

// ---------- one document ----------
async function loadDoc(env, id) {
  const doc = await env.DB.prepare("SELECT * FROM docs WHERE id = ?").bind(id).first();
  if (!doc) return null;
  const client = doc.client_id ? await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(doc.client_id).first() : null;
  const quote = doc.quote_id ? await env.DB.prepare("SELECT id, number FROM docs WHERE id = ?").bind(doc.quote_id).first() : null;
  return { doc, client, quote };
}

// ---------- receipts ----------
async function receiptsFor(env, invoiceId) {
  return (await env.DB.prepare("SELECT * FROM receipts WHERE invoice_id = ? ORDER BY id").bind(invoiceId).all()).results;
}
const receipted = list => list.filter(r => r.status !== "void").reduce((a, r) => a + r.amount_sen, 0);

// Issue a receipt for money already recorded on the invoice. Returns the new receipt id, or null if nothing is left to receipt.
export async function createReceipt(env, invoice, amountSen, paidDate, method, ref) {
  const left = (invoice.paid_sen || 0) - receipted(await receiptsFor(env, invoice.id));
  const amount = Math.min(amountSen, left);
  if (amount <= 0) return null;
  const number = await nextNumber(env, "receipt", myToday());
  const r = await env.DB.prepare("INSERT INTO receipts (number, token, invoice_id, client_id, amount_sen, paid_date, method, ref) VALUES (?,?,?,?,?,?,?,?)")
    .bind(number, randomToken(), invoice.id, invoice.client_id, amount, isYmd(paidDate) ? paidDate : (invoice.paid_date || myToday()),
      clean(method, 80) || "Bank transfer", clean(ref, 160) || null).run();
  return r.meta.last_row_id;
}

async function receiptPage(env, id) {
  const rc = await env.DB.prepare("SELECT * FROM receipts WHERE id = ?").bind(id).first();
  if (!rc) return go("/admin");
  const invoice = await env.DB.prepare("SELECT * FROM docs WHERE id = ?").bind(rc.invoice_id).first();
  const client = rc.client_id ? await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(rc.client_id).first() : null;
  const s = await getSettings(env);
  const toDate = receipted((await receiptsFor(env, rc.invoice_id)).filter(r => r.id <= rc.id));
  const link = `${siteUrl(env)}/d/${rc.token}`;
  const phone = (client?.phone || "").replace(/\D/g, "").replace(/^0/, "60");
  const waText = encodeURIComponent(`Hi ${client?.name || ""}, here is receipt ${rc.number} from ${s.biz_name} for RM ${money(rc.amount_sen)}: ${link}`);
  const voidBtn = rc.status === "issued" ? `<form method="post" action="/admin/receipt/${rc.id}/void" onsubmit="return confirm('Void ${esc(rc.number)}?')" style="display:inline"><button class="danger">Void</button></form>` : "";
  const extra = `${adminNav()}<div class="extra noprint" style="max-width:1100px;margin:0 auto;padding:20px 16px 0">
<p><a href="/admin/doc/${rc.invoice_id}">← Invoice ${esc(invoice?.number || "")}</a></p>
<h1 style="margin:6px 0;text-align:left;font-size:22px;color:var(--navy)">${esc(rc.number)} ${pill("receipt", rc.status)}</h1>
<div class="share"><input value="${link}" readonly onclick="this.select()"><button type="button" onclick="navigator.clipboard.writeText('${link}');this.textContent='Copied'">Copy link</button>
<a class="btn" target="_blank" rel="noopener" href="https://wa.me/${phone}?text=${waText}">WhatsApp</a><a class="btn" target="_blank" href="/d/${rc.token}">Open client view</a>${voidBtn}</div></div>`;
  const bits = ADMIN_CSS.split("\n").filter(l => /^(header|\.hd|\.(pill|btn|actions|share|flash|note))/.test(l)).join("\n");
  return page(renderReceipt(rc, invoice, client, s, { extra, receivedToDate: toDate })
    .replace("</style>", `${bits}\n.extra input{font:14px Arial;padding:8px 10px;border:1px solid #CBD5E1;border-radius:7px}\n.extra a{color:var(--teal)}\n</style>`));
}

const MSG = {
  created: "Created as a draft. Check it, then press “Mark as sent” to get the client link.",
  saved: "Saved.", sent: "Marked as sent. Share the link below with the client.", paid: "Payment recorded.",
  locked: "This document can no longer be edited.", invoiced: "Invoice created from the quotation.", accepted: "Marked as accepted.",
  receipt: "Receipt issued. Share it with the client from the receipt page.",
};

async function docPage(env, id, url) {
  const loaded = await loadDoc(env, id);
  if (!loaded) return go("/admin");
  const { doc, client, quote } = loaded;
  const s = await getSettings(env);
  const isInv = doc.kind === "invoice";
  const link = `${siteUrl(env)}/d/${doc.token}`;
  const btn = (action, label, cls = "", extra = "") => `<form method="post" action="/admin/doc/${doc.id}/act"${extra}><input type="hidden" name="action" value="${action}"><button class="${cls}">${label}</button></form>`;
  const acts = [];
  const editable = !["paid", "void", "invoiced"].includes(doc.status);
  if (editable) acts.push(`<a class="btn" href="/admin/doc/${doc.id}/edit">Edit</a>`);
  if (doc.status === "draft") acts.push(btn("send", "Mark as sent", "p"));
  if (!isInv && ["sent", "draft"].includes(doc.status)) acts.push(btn("accept", "Client accepted"), btn("decline", "Client declined"));
  let invoices = [];
  if (!isInv) {
    invoices = (await env.DB.prepare("SELECT id, number, invoice_type, status, bill_sen FROM docs WHERE quote_id = ? ORDER BY id").bind(doc.id).all()).results;
    const live = invoices.filter(i => i.status !== "void");
    const hasDeposit = live.some(i => i.invoice_type === "deposit");
    if (["sent", "accepted"].includes(doc.status) && !live.length) {
      if (doc.deposit_pct > 0) acts.push(btn("inv_deposit", `Create deposit invoice (${doc.deposit_pct}%)`, "p"));
      acts.push(btn("inv_full", "Create full invoice"));
    }
    if (hasDeposit && doc.status !== "invoiced") acts.push(btn("inv_balance", "Create balance invoice", "p"));
  }
  if (isInv && doc.status === "sent") {
    const a = invoiceAmounts(doc);
    acts.push(`<form method="post" action="/admin/doc/${doc.id}/act" class="share"><input type="hidden" name="action" value="pay">
      <input name="amount" type="number" step="0.01" value="${(a.balance / 100).toFixed(2)}" style="width:120px" title="Amount received (RM)">
      <input name="paid_date" type="date" value="${myToday()}" style="width:150px"><input name="ref" placeholder="Bank ref (optional)" style="width:170px">
      <label style="display:inline;color:inherit;font-size:13px"><input type="checkbox" name="receipt" value="1" style="width:auto"> also issue receipt</label>
      <button class="p">Record payment</button></form>`);
  }
  let receiptsHtml = "";
  if (isInv) {
    const rcs = await receiptsFor(env, doc.id);
    const left = (doc.paid_sen || 0) - receipted(rcs);
    receiptsHtml = (rcs.length ? `<p>Receipts: ${rcs.map(r => `<a href="/admin/receipt/${r.id}">${esc(r.number)}</a> RM ${money(r.amount_sen)}${r.status === "void" ? " (void)" : ""}`).join(", ")}</p>` : "") +
      (left > 0 ? `<form method="post" action="/admin/doc/${doc.id}/act" class="share" style="margin:8px 0"><input type="hidden" name="action" value="receipt">
        <span class="note">RM ${money(left)} received without a receipt:</span>
        <input name="amount" type="number" step="0.01" value="${(left / 100).toFixed(2)}" style="width:120px"><input name="paid_date" type="date" value="${esc(doc.paid_date || myToday())}" style="width:150px">
        <input name="method" value="Bank transfer" style="width:150px"><input name="ref" value="${esc(doc.payment_ref || "")}" placeholder="Bank ref" style="width:170px"><button class="p">Issue receipt</button></form>` : "");
  }
  if (isInv && ["draft", "sent"].includes(doc.status)) acts.push(btn("void", "Void", "danger", ` onsubmit="return confirm('Void ${esc(doc.number)}? It stays in the list as VOID.')"`));
  if (doc.status === "draft") acts.push(btn("delete", "Delete draft", "danger", ` onsubmit="return confirm('Delete draft ${esc(doc.number)}?')"`));
  if (isInv && (doc.invoice_type || "full") === "full") acts.push(btn("repeat", "↻ Next month's invoice", "p"));
  acts.push(btn("duplicate", "Duplicate"));

  const phone = (client?.phone || "").replace(/\D/g, "").replace(/^0/, "60");
  const what = isInv ? "invoice" : "quotation";
  const waText = encodeURIComponent(`Hi ${client?.name || ""}, here is ${what} ${doc.number} from ${s.biz_name}: ${link}`);
  const mailto = `mailto:${encodeURIComponent(client?.email || "")}?subject=${encodeURIComponent(`${doc.number} from ${s.biz_name}`)}&body=${waText}`;
  const share = doc.status === "draft" ? `<p class="note">The client link works after “Mark as sent”.</p>` :
    `<div class="share"><input value="${link}" readonly onclick="this.select()"><button type="button" onclick="navigator.clipboard.writeText('${link}');this.textContent='Copied'">Copy link</button>
     <a class="btn" target="_blank" rel="noopener" href="https://wa.me/${phone}?text=${waText}">WhatsApp</a><a class="btn" href="${mailto}">Email</a><a class="btn" target="_blank" href="/d/${doc.token}">Open client view</a></div>`;
  const related = !isInv && invoices.length ? `<p>Invoices: ${invoices.map(i => `<a href="/admin/doc/${i.id}">${esc(i.number)}</a> (${esc(i.invoice_type)}, ${esc(STATUS.invoice[i.status])})`).join(", ")}</p>` :
    isInv && quote ? `<p>From quotation <a href="/admin/doc/${quote.id}">${esc(quote.number)}</a></p>` : "";
  const msg = MSG[url.searchParams.get("msg")] ? `<div class="flash">${MSG[url.searchParams.get("msg")]}</div>` : "";
  const admin = `${adminNav()}<div class="extra noprint" style="max-width:1100px;margin:0 auto;padding:20px 16px 0">
<p><a href="/admin">← All documents</a></p>${msg}
<h1 style="margin:6px 0;text-align:left;font-size:22px;color:var(--navy)">${esc(doc.number)} ${pill(doc.kind, doc.status)}</h1>${related}
<div class="actions">${acts.join("")}</div>${receiptsHtml}${share}</div>`;
  const body = renderDoc(doc, client, s, { extra: admin, quoteNumber: quote?.number });
  // Add only the admin bits (buttons, pills, share box) so the document itself keeps its own look.
  const bits = ADMIN_CSS.split("\n").filter(l => /^(header|\.hd|\.(pill|btn|actions|share|flash|note))/.test(l)).join("\n");
  return page(body.replace("</style>", `${bits}\n.extra input{font:14px Arial;padding:8px 10px;border:1px solid #CBD5E1;border-radius:7px}\n.extra a{color:var(--teal)}\n</style>`));
}

async function act(request, env, id) {
  const d = await form(request);
  const loaded = await loadDoc(env, id);
  if (!loaded) return go("/admin");
  const { doc } = loaded;
  const s = await getSettings(env);
  const set = (sql, ...args) => env.DB.prepare(`UPDATE docs SET ${sql}, updated_at=datetime('now') WHERE id=?`).bind(...args, id).run();
  switch (d.action) {
    case "send": if (doc.status === "draft") await set("status='sent'"); return go(`/admin/doc/${id}?msg=sent`);
    case "accept": await set("status='accepted', accepted_at=datetime('now'), accepted_name=COALESCE(accepted_name,'(recorded by owner)')"); return go(`/admin/doc/${id}?msg=accepted`);
    case "decline": await set("status='declined'"); return go(`/admin/doc/${id}`);
    case "void": if (doc.kind === "invoice" && doc.status !== "paid") await set("status='void'"); return go(`/admin/doc/${id}`);
    case "delete":
      if (doc.status === "draft") { await env.DB.prepare("DELETE FROM docs WHERE id = ?").bind(id).run(); return go("/admin"); }
      return go(`/admin/doc/${id}`);
    case "pay": {
      if (doc.kind !== "invoice" || doc.status !== "sent") return go(`/admin/doc/${id}`);
      const amount = toSen(d.amount);
      if (amount <= 0) return go(`/admin/doc/${id}`);
      const paid = (doc.paid_sen || 0) + amount;
      const full = paid >= invoiceAmounts(doc).bill;
      const paidOn = isYmd(d.paid_date) ? d.paid_date : myToday();
      await set("paid_sen=?, paid_date=?, payment_ref=?, status=?", paid, paidOn, clean(d.ref, 120) || doc.payment_ref, full ? "paid" : "sent");
      await env.DB.prepare("INSERT INTO payments (invoice_id, amount_sen, paid_date, ref) VALUES (?,?,?,?)").bind(id, amount, paidOn, clean(d.ref, 160) || null).run();
      if (d.receipt === "1") {
        const fresh = await env.DB.prepare("SELECT * FROM docs WHERE id = ?").bind(id).first();
        const rid = await createReceipt(env, fresh, amount, d.paid_date, "Bank transfer", d.ref);
        if (rid) return go(`/admin/receipt/${rid}?msg=receipt`);
      }
      return go(`/admin/doc/${id}?msg=paid`);
    }
    case "receipt": {
      if (doc.kind !== "invoice") return go(`/admin/doc/${id}`);
      const rid = await createReceipt(env, doc, toSen(d.amount), d.paid_date, d.method, d.ref);
      return go(rid ? `/admin/receipt/${rid}?msg=receipt` : `/admin/doc/${id}`);
    }
    case "repeat": {
      // Same client and items with every date in the subject, items and notes moved one month on; a new draft for review.
      if (doc.kind !== "invoice" || (doc.invoice_type || "full") !== "full") return go(`/admin/doc/${id}`);
      const issue = myToday();
      const number = await nextNumber(env, "invoice", issue);
      const items = JSON.stringify(JSON.parse(doc.items).map(it => ({ ...it, desc: nextMonthText(it.desc) })));
      const r = await env.DB.prepare(`INSERT INTO docs (kind, number, token, client_id, title, issue_date, end_date, status, items, discount_sen, total_sen, deposit_pct, invoice_type, bill_sen, notes, terms)
          VALUES ('invoice',?,?,?,?,?,?,'draft',?,?,?,0,'full',?,?,?)`)
        .bind(number, randomToken(), doc.client_id, nextMonthText(doc.title), issue, addDays(issue, s.invoice_due_days), items, doc.discount_sen, doc.total_sen,
          doc.total_sen, nextMonthText(doc.notes), doc.terms).run();
      return go(`/admin/doc/${r.meta.last_row_id}?msg=created`);
    }
    case "duplicate": {
      const issue = myToday();
      const number = await nextNumber(env, doc.kind, issue);
      const end = addDays(issue, doc.kind === "invoice" ? s.invoice_due_days : s.quote_valid_days);
      const r = await env.DB.prepare(`INSERT INTO docs (kind, number, token, client_id, title, issue_date, end_date, status, items, discount_sen, total_sen, deposit_pct, invoice_type, bill_sen, notes, terms)
          VALUES (?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?)`)
        .bind(doc.kind, number, randomToken(), doc.client_id, doc.title, issue, end, doc.items, doc.discount_sen, doc.total_sen, doc.deposit_pct,
          doc.kind === "invoice" ? "full" : null, doc.kind === "invoice" ? doc.total_sen : null, doc.notes, doc.terms).run();
      return go(`/admin/doc/${r.meta.last_row_id}?msg=created`);
    }
    case "inv_full": case "inv_deposit": case "inv_balance": {
      if (doc.kind !== "quote") return go(`/admin/doc/${id}`);
      const type = d.action.slice(4);
      const prior = (await env.DB.prepare("SELECT COALESCE(SUM(bill_sen),0) AS s FROM docs WHERE quote_id = ? AND status != 'void'").bind(id).first()).s;
      const bill = type === "full" ? doc.total_sen : type === "deposit" ? Math.round(doc.total_sen * doc.deposit_pct / 100) : doc.total_sen - prior;
      if (bill <= 0) return go(`/admin/doc/${id}`);
      const issue = myToday();
      const number = await nextNumber(env, "invoice", issue);
      const r = await env.DB.prepare(`INSERT INTO docs (kind, number, token, client_id, title, issue_date, end_date, status, items, discount_sen, total_sen, deposit_pct, invoice_type, bill_sen, quote_id, order_id, notes)
          VALUES ('invoice',?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?)`)
        .bind(number, randomToken(), doc.client_id, doc.title, issue, addDays(issue, s.invoice_due_days), doc.items, doc.discount_sen, doc.total_sen,
          doc.deposit_pct, type, bill, id, doc.order_id, doc.notes).run();
      const quoteStatus = type === "deposit" ? "accepted" : "invoiced";
      await set(`status='${quoteStatus}', accepted_at=COALESCE(accepted_at, datetime('now'))`);
      return go(`/admin/doc/${r.meta.last_row_id}?msg=invoiced`);
    }
  }
  return go(`/admin/doc/${id}`);
}

// ---------- settings ----------
const SETTING_FIELDS = [
  ["biz_name", "Business name"], ["reg_no", "SSM registration no."], ["address", "Address", "area"], ["email", "Email"], ["phone", "Phone"],
  ["whatsapp", "WhatsApp number for clients (optional, defaults to phone)"], ["website", "Website"], ["tin", "Tax number (TIN)"],
  ["logo_url", "Logo image URL (optional, https)"], ["number_prefix", "Number prefix, e.g. ACME → ACME-INV-2026-0001 (set before your first document)"], ["bank_name", "Bank"], ["bank_account_name", "Account name"], ["bank_account_no", "Account number"],
  ["quote_valid_days", "Quotation valid for (days)"], ["deposit_pct", "Default deposit (%)"], ["invoice_due_days", "Invoice due after (days)"],
  ["quote_terms", "Standard quotation terms", "area"], ["invoice_terms", "Standard invoice terms", "area"], ["sst_note", "SST note"],
];
async function settingsPage(env, url) {
  const s = await getSettings(env);
  const fields = SETTING_FIELDS.map(([k, label, type]) => `<label>${label}</label>${type === "area" ? `<textarea name="${k}" rows="${k.endsWith("terms") ? 6 : 2}">${esc(s[k])}</textarea>` : `<input name="${k}" value="${esc(s[k])}">`}`).join("");
  const msg = { saved: "Saved.", backup: "✅ Backup emailed to you. Look for “[Billing backup]”.", backupfail: "Backup could not be sent. Try again later." }[url.searchParams.get("msg")];
  const backupMsg = ["backup", "backupfail"].includes(url.searchParams.get("msg")) ? msg : "";
  return adminPage("Settings", `<h1>Settings</h1>${msg && !backupMsg ? `<div class="flash">${msg}</div>` : ""}
<form method="post" action="/admin/settings"><fieldset><legend>Shown on every quotation and invoice</legend>${fields}
<p class="note">In the terms you can use {deposit}, {due}, {email} and {phone}; they are filled in on each document.</p></fieldset><button class="p">Save settings</button></form>
<h2 id="backup">Backup</h2><p class="note">A full backup (documents, receipts, clients, numbering, settings) is emailed to you every night (cron in wrangler.jsonc).</p>
${backupMsg ? `<div class="flash">${backupMsg}</div>` : ""}
<form method="post" action="/admin/backup" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Sending…'"><button>Email a backup now</button></form>`);
}
async function saveSettings(request, env) {
  const d = await form(request);
  const stmts = SETTING_FIELDS.filter(([k]) => k in d).map(([k]) =>
    env.DB.prepare("INSERT INTO billing_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, clean(d[k], 4000)));
  if (stmts.length) await env.DB.batch(stmts);
  return go("/admin/settings?msg=saved");
}

// ---------- client view ----------
async function clientView(env, token, url) {
  const doc = await env.DB.prepare("SELECT * FROM docs WHERE token = ?").bind(token).first();
  if (!doc) {
    const rc = await env.DB.prepare("SELECT * FROM receipts WHERE token = ?").bind(token).first();
    if (rc) {
      const inv = await env.DB.prepare("SELECT * FROM docs WHERE id = ?").bind(rc.invoice_id).first();
      const cl = rc.client_id ? await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(rc.client_id).first() : null;
      const toDate = receipted((await receiptsFor(env, rc.invoice_id)).filter(r => r.id <= rc.id));
      const bar = `<div class="bar noprint"><button class="p" onclick="window.print()">Download PDF / Print</button></div>`;
      return page(renderReceipt(rc, inv, cl, await getSettings(env), { extra: bar, receivedToDate: toDate }));
    }
  }
  if (!doc || doc.status === "draft") return page("<!doctype html><title>Not found</title><p style='font:16px Arial;padding:40px'>This document is not available.</p>", 404);
  const client = doc.client_id ? await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(doc.client_id).first() : null;
  const quote = doc.quote_id ? await env.DB.prepare("SELECT number FROM docs WHERE id = ?").bind(doc.quote_id).first() : null;
  const s = await getSettings(env);
  const canAccept = doc.kind === "quote" && doc.status === "sent" && (!doc.end_date || doc.end_date >= myToday());
  const accepted = url.searchParams.get("accepted") === "1";
  const waNo = String(s.whatsapp || s.phone || "").replace(/\D/g, "").replace(/^0/, "60");
  const wa = waNo ? `https://wa.me/${waNo}?text=${encodeURIComponent(`Hi, about ${doc.number}: `)}` : "";
  const extra = `<div class="bar noprint"><button class="p" onclick="window.print()">Download PDF / Print</button>${wa ? `<a class="btn" href="${wa}" target="_blank" rel="noopener">Ask on WhatsApp</a>` : ""}</div>
${accepted ? `<div class="extra noprint"><p style="background:#E6F5F4;border:1px solid #B7E3E0;padding:10px 14px;border-radius:8px;margin:12px 0 0">Thank you! The quotation is accepted. We will send the ${doc.deposit_pct > 0 ? "deposit invoice" : "invoice"} shortly.</p></div>` : ""}
${canAccept ? `<div class="extra noprint"><form method="post" action="/d/${esc(token)}/accept" style="background:#fff;border:1px solid #E3E8EF;border-radius:10px;padding:14px 16px;margin-top:12px">
<b>Accept this quotation</b><p style="margin:4px 0 10px;color:#4A5D73;font-size:13px">Type your name to confirm you accept the scope, price and terms below.</p>
<input name="name" required maxlength="120" placeholder="Your full name" style="font:14px Arial;padding:8px 10px;border:1px solid #CBD5E1;border-radius:7px;width:260px;max-width:100%">
<input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
<button class="p" style="font:600 14px Arial;background:#0B7A75;color:#fff;border:0;border-radius:8px;padding:9px 16px;margin-left:6px;cursor:pointer">Accept quotation</button></form></div>` : ""}`;
  return page(renderDoc(doc, client, s, { extra, quoteNumber: quote?.number }));
}

async function acceptQuote(request, env, ctx, token) {
  const d = await form(request);
  const doc = await env.DB.prepare("SELECT * FROM docs WHERE token = ?").bind(token).first();
  if (!doc || doc.kind !== "quote" || clean(d.website, 50)) return go(`/d/${token}`);
  const name = clean(d.name, 120);
  if (doc.status === "sent" && name) {
    await env.DB.prepare("UPDATE docs SET status='accepted', accepted_at=datetime('now'), accepted_name=?, updated_at=datetime('now') WHERE id=?").bind(name, doc.id).run();
    ctx.waitUntil(notify(env, `[Billing] ${doc.number} accepted by ${name}`,
      `Quotation ${doc.number} (RM ${money(doc.total_sen)}) was accepted by ${name}.\n\nNext: create the ${doc.deposit_pct > 0 ? "deposit" : "full"} invoice at ${siteUrl(env)}/admin/doc/${doc.id}`,
      "Billing").catch(err => console.error("accept notify failed", err)));
  }
  return go(`/d/${token}?accepted=1`);
}

// ---------- router ----------
export async function handleBilling(request, env, ctx, url) {
  const p = url.pathname;
  const post = request.method === "POST";
  const dm = p.match(/^\/d\/([A-Za-z0-9_-]{16,40})(\/accept)?\/?$/);
  if (dm) {
    if (dm[2]) return post && sameOrigin(request, env) ? acceptQuote(request, env, ctx, dm[1]) : go(`/d/${dm[1]}`);
    return request.method === "GET" ? clientView(env, dm[1], url) : null;
  }
  if (p !== "/admin" && !p.startsWith("/admin/")) return null;
  if (post && !sameOrigin(request, env)) return page("Forbidden", 403);

  if (p === "/admin/login") return (await isAdmin(request, env)) ? go("/admin") : loginPage();
  if (p === "/admin/login/send" && post) return sendCode(request, env, ctx);
  if (p === "/admin/login/verify" && post) return verifyCode(request, env);
  if (!(await isAdmin(request, env))) return go("/admin/login");
  if (p === "/admin/logout" && post) return logout(request, env);

  if (p === "/admin" || p === "/admin/") return dashboard(env, url);
  if (p.startsWith("/admin/books")) {
    const res = await handleBooks(request, env, url);
    if (res) return res;
  }
  if (p === "/admin/new") return editForm(env, url);
  if (p === "/admin/save" && post) return saveDoc(request, env);
  if (p === "/admin/settings") return post ? saveSettings(request, env) : settingsPage(env, url);
  if (p === "/admin/backup" && post) {
    const r = await emailBackup(env);
    return go(`/admin/settings?msg=${r.ok ? "backup" : "backupfail"}#backup`);
  }
  const rm = p.match(/^\/admin\/receipt\/(\d+)(\/void)?$/);
  if (rm) {
    if (rm[2] && post) {
      await env.DB.prepare("UPDATE receipts SET status = 'void' WHERE id = ?").bind(int(rm[1])).run();
      return go(`/admin/receipt/${int(rm[1])}`);
    }
    return receiptPage(env, int(rm[1]));
  }
  const m = p.match(/^\/admin\/doc\/(\d+)(\/edit|\/act)?$/);
  if (m) {
    const id = int(m[1]);
    if (m[2] === "/act" && post) return act(request, env, id);
    if (m[2] === "/edit") {
      const loaded = await loadDoc(env, id);
      return loaded ? editForm(env, url, loaded.doc) : go("/admin");
    }
    return docPage(env, id, url);
  }
  return go("/admin");
}
