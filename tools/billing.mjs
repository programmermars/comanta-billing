// Quotations, invoices and receipts from the command line (the same D1 tables as /admin).
// Handy for scripts and AI assistants: write a JSON file, then run `new`.
//
//   node tools/billing.mjs list [quote|invoice]
//   node tools/billing.mjs show QT-2026-0001
//   node tools/billing.mjs new quote doc.json          (or: new invoice doc.json)  -> draft
//   node tools/billing.mjs send QT-2026-0001            draft -> sent, prints the client link
//   node tools/billing.mjs invoice QT-2026-0001 deposit|full|balance   -> draft invoice from a quotation
//   node tools/billing.mjs paid INV-2026-0001 1000 [2026-11-20] [bank ref]
//   node tools/billing.mjs receipt INV-2026-0001 [amount] [2026-11-20] [bank ref]   receipt for money already recorded
//   node tools/billing.mjs expense add exp.json          record a business expense (format below)
//   node tools/billing.mjs expense list [2026]
//   node tools/billing.mjs books [2026]                  money received, expenses and profit per month
//   node tools/billing.mjs sync                          backup + PDFs + income.csv + expenses.csv into ./exports
//   node tools/billing.mjs backup                        whole database to ./exports/backups (last 90 days kept)
// Add --local to use the local database from `npm run dev` instead of the live one.
// Short numbers work too: inv-2026-1 means INV-2026-0001 (with your number prefix, if you set one).
//
// doc.json:
// { "client": {"company": "ABC Trading Sdn Bhd", "name": "Mr Tan", "email": "...", "phone": "...", "address": "...", "reg_no": "", "tin": ""},
//   "title": "Website setup", "items": [{"desc": "Website setup", "qty": 1, "price": 1500}],
//   "discount": 0, "deposit_pct": 50, "notes": "", "issue_date": "2026-11-20", "end_date": "" }
// exp.json:
// { "spent_date": "2026-11-18", "vendor": "SSM", "description": "Business profile", "category": "registration", "amount": 25.80,
//   "paid_from": "business", "reimbursed": "no", "client": "", "reimbursed_date": "", "deductible_pct": 100, "file": "", "notes": "" }
//
// Settings (environment variables): BILLING_EXPORT_DIR (default ./exports), CHROME_PATH (for PDFs).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync, copyFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STATUS, EXPENSE_CATEGORIES, categoryName, deductibleSen, money, toSen, myToday, addDays, isYmd, calc, invoiceAmounts, randomToken, formatNumber, normalizeNumber, counterSql, renderDoc, renderReceipt,
} from "../src/billing-core.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const LOCAL = args.includes("--local");
const [cmd, a, b, c, ...rest] = args.filter(x => x !== "--local");
const EXPORT = resolve(process.env.BILLING_EXPORT_DIR || join(root, "exports"));

// Database name and public URL come from wrangler.jsonc, so there is one place to configure.
const wranglerConfig = (() => {
  const text = readFileSync(join(root, "wrangler.jsonc"), "utf8")
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(text);
})();
const DB = wranglerConfig.d1_databases?.[0]?.database_name || "billing-db";
const SITE = String(wranglerConfig.vars?.SITE_URL || "").replace(/\/+$/, "");

function chromePath() {
  const candidates = [process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const found = candidates.find(p => p && existsSync(p));
  if (!found) throw new Error("Chrome / Edge not found: set CHROME_PATH to make PDFs");
  return found;
}

const q = s => (s == null || s === "" ? "NULL" : "'" + String(s).replace(/'/g, "''") + "'");
const n = v => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);

function wranglerCli() {
  const local = join(root, "node_modules", "wrangler", "wrangler-dist", "cli.js");
  if (!existsSync(local)) throw new Error('wrangler not found: run "npm install" first');
  return local;
}
// Run SQL on D1 and return the rows of the last statement.
function sql(command) {
  const out = execFileSync(process.execPath, [wranglerCli(), "d1", "execute", DB, LOCAL ? "--local" : "--remote", "--json", "--command", command],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const res = JSON.parse(out.slice(out.indexOf("[")));
  return res[res.length - 1].results || [];
}
const one = command => sql(command)[0];

let cachedSettings;
const settings = () => (cachedSettings ||= Object.fromEntries(sql("SELECT key, value FROM billing_settings").map(r => [r.key, r.value])));
function findDoc(number) {
  const d = one(`SELECT * FROM docs WHERE number = ${q(normalizeNumber(number, settings().number_prefix))}`);
  if (!d) throw new Error(`no document ${number}`);
  return d;
}
const link = token => `${SITE || "<SITE_URL>"}/d/${token}`;
function nextNumber(kind, issue) {
  const year = issue.slice(0, 4);
  return formatNumber(kind, year, one(counterSql(kind, year)).value, settings().number_prefix);
}

function upsertClient(cl = {}) {
  const name = cl.name || cl.company;
  if (!name) return null;
  const existing = one(`SELECT id FROM clients WHERE (company IS NOT NULL AND company != '' AND lower(company) = lower(${q(cl.company || "")}))
      OR (email IS NOT NULL AND email != '' AND lower(email) = lower(${q(cl.email || "")})) ORDER BY id LIMIT 1`);
  if (existing) {
    const sets = ["name", "company", "email", "phone", "address", "reg_no", "tin"].filter(k => cl[k]).map(k => `${k} = ${q(cl[k])}`);
    if (sets.length) sql(`UPDATE clients SET ${sets.join(", ")} WHERE id = ${existing.id}`);
    return existing.id;
  }
  return one(`INSERT INTO clients (name, company, email, phone, address, reg_no, tin) VALUES (${q(name)}, ${q(cl.company)}, ${q(cl.email)}, ${q(cl.phone)}, ${q(cl.address)}, ${q(cl.reg_no)}, ${q(cl.tin)}) RETURNING id`).id;
}

function newDoc(kind, file) {
  if (!["quote", "invoice"].includes(kind)) throw new Error('say "new quote <file>" or "new invoice <file>"');
  const data = JSON.parse(readFileSync(file, "utf8"));
  const s = settings();
  const { items, discount, total } = calc((data.items || []).map(it => ({ desc: it.desc, qty: it.qty ?? 1, price_sen: toSen(it.price) })), toSen(data.discount || 0));
  if (!items.length) throw new Error("no items");
  const issue = isYmd(data.issue_date) ? data.issue_date : myToday();
  const end = isYmd(data.end_date) ? data.end_date : addDays(issue, kind === "invoice" ? s.invoice_due_days : s.quote_valid_days);
  const clientId = upsertClient(data.client);
  const deposit = kind === "quote" ? n(data.deposit_pct ?? s.deposit_pct) : 0;
  const number = nextNumber(kind, issue);
  sql(`INSERT INTO docs (kind, number, token, client_id, title, issue_date, end_date, status, items, discount_sen, total_sen, deposit_pct, invoice_type, bill_sen, notes, terms)
       VALUES (${q(kind)}, ${q(number)}, ${q(randomToken())}, ${clientId ?? "NULL"}, ${q(data.title)}, ${q(issue)}, ${q(end)}, 'draft', ${q(JSON.stringify(items))},
       ${discount}, ${total}, ${deposit}, ${kind === "invoice" ? "'full'" : "NULL"}, ${kind === "invoice" ? total : "NULL"}, ${q(data.notes)}, ${q(data.terms)})`);
  const d = findDoc(number);
  console.log(`${number} created as a draft: RM ${money(total)}${deposit ? ` (deposit ${deposit}% = RM ${money(Math.round(total * deposit / 100))})` : ""}`);
  console.log(`Check it: ${SITE}/admin/doc/${d.id}   then: node tools/billing.mjs send ${number}`);
}

function show(number) {
  const d = findDoc(number);
  const cl = d.client_id ? one(`SELECT * FROM clients WHERE id = ${d.client_id}`) : {};
  const items = JSON.parse(d.items);
  console.log(`${d.number}  ${STATUS[d.kind][d.status]}  ${cl?.company || cl?.name || "-"}  ${d.title || ""}`);
  items.forEach((it, i) => console.log(`  ${i + 1}. ${it.desc}  x${it.qty}  RM ${money(it.price_sen)}`));
  console.log(`  Total RM ${money(d.total_sen)}${d.discount_sen ? ` (after discount RM ${money(d.discount_sen)})` : ""}`);
  if (d.kind === "invoice") { const x = invoiceAmounts(d); console.log(`  Billed RM ${money(x.bill)}  paid RM ${money(x.paid)}  due RM ${money(x.balance)}  (${d.invoice_type})`); }
  console.log(`  Admin: ${SITE}/admin/doc/${d.id}${d.status !== "draft" ? `\n  Client link: ${link(d.token)}` : ""}`);
}

function list(kind) {
  const where = ["quote", "invoice"].includes(kind) ? `WHERE d.kind = ${q(kind)}` : "";
  const rows = sql(`SELECT d.number, d.status, d.kind, COALESCE(c.company, c.name) AS client, d.title, d.issue_date, d.total_sen, d.bill_sen, d.paid_sen
      FROM docs d LEFT JOIN clients c ON c.id = d.client_id ${where} ORDER BY d.id DESC LIMIT 50`);
  if (!rows.length) return console.log("(nothing yet)");
  console.table(rows.map(r => ({ no: r.number, status: STATUS[r.kind][r.status], client: r.client, subject: (r.title || "").slice(0, 40), date: r.issue_date,
    amount: money(r.kind === "invoice" ? (r.bill_sen ?? r.total_sen) : r.total_sen), paid: r.kind === "invoice" ? money(r.paid_sen) : "" })));
}

function send(number) {
  const d = findDoc(number);
  if (d.status === "draft") sql(`UPDATE docs SET status = 'sent', updated_at = datetime('now') WHERE id = ${d.id}`);
  console.log(`${d.number} is sent. Client link: ${link(d.token)}`);
}

function invoiceFrom(number, type) {
  const d = findDoc(number);
  if (d.kind !== "quote") throw new Error(`${number} is not a quotation`);
  if (!["full", "deposit", "balance"].includes(type)) throw new Error("type must be deposit, full or balance");
  const s = settings();
  const prior = one(`SELECT COALESCE(SUM(bill_sen),0) AS s FROM docs WHERE quote_id = ${d.id} AND status != 'void'`).s;
  if (type !== "balance" && prior > 0) throw new Error(`${number} already has invoices; use "balance"`);
  const bill = type === "full" ? d.total_sen : type === "deposit" ? Math.round(d.total_sen * d.deposit_pct / 100) : d.total_sen - prior;
  if (bill <= 0) throw new Error("nothing left to invoice");
  const issue = myToday();
  const inv = nextNumber("invoice", issue);
  sql(`INSERT INTO docs (kind, number, token, client_id, title, issue_date, end_date, status, items, discount_sen, total_sen, deposit_pct, invoice_type, bill_sen, quote_id, order_id, notes)
       VALUES ('invoice', ${q(inv)}, ${q(randomToken())}, ${d.client_id ?? "NULL"}, ${q(d.title)}, ${q(issue)}, ${q(addDays(issue, s.invoice_due_days))}, 'draft', ${q(d.items)},
       ${d.discount_sen}, ${d.total_sen}, ${d.deposit_pct}, ${q(type)}, ${bill}, ${d.id}, ${d.order_id ?? "NULL"}, ${q(d.notes)});
       UPDATE docs SET status = '${type === "deposit" ? "accepted" : "invoiced"}', accepted_at = COALESCE(accepted_at, datetime('now')), updated_at = datetime('now') WHERE id = ${d.id}`);
  console.log(`${inv} (${type}) created as a draft for RM ${money(bill)}. Then: node tools/billing.mjs send ${inv}`);
}

function paid(number, amount, date, ref) {
  const d = findDoc(number);
  if (d.kind !== "invoice" || d.status !== "sent") throw new Error(`${number} must be a sent invoice (now: ${d.status})`);
  const add = toSen(amount);
  if (add <= 0) throw new Error("amount must be more than 0");
  const total = (d.paid_sen || 0) + add;
  const full = total >= invoiceAmounts(d).bill;
  const on = isYmd(date) ? date : myToday();
  sql(`UPDATE docs SET paid_sen = ${total}, paid_date = ${q(on)}, payment_ref = ${q(ref || d.payment_ref)},
       status = '${full ? "paid" : "sent"}', updated_at = datetime('now') WHERE id = ${d.id};
       INSERT INTO payments (invoice_id, amount_sen, paid_date, ref) VALUES (${d.id}, ${add}, ${q(on)}, ${q(ref)})`);
  console.log(`${d.number}: received RM ${money(add)}${full ? " — fully paid" : `, still due RM ${money(invoiceAmounts(d).bill - total)}`}`);
}

// Official receipt for payment already recorded with "paid" (default: everything not yet receipted).
function receipt(number, amount, date, ref) {
  const d = findDoc(number);
  if (d.kind !== "invoice") throw new Error(`${number} is not an invoice`);
  const done = one(`SELECT COALESCE(SUM(amount_sen),0) AS s FROM receipts WHERE invoice_id = ${d.id} AND status != 'void'`).s;
  const left = (d.paid_sen || 0) - done;
  if (left <= 0) throw new Error(`${d.number}: no recorded payment without a receipt (record it first with "paid")`);
  const amt = amount ? Math.min(toSen(amount), left) : left;
  const no = nextNumber("receipt", myToday());
  sql(`INSERT INTO receipts (number, token, invoice_id, client_id, amount_sen, paid_date, method, ref)
       VALUES (${q(no)}, ${q(randomToken())}, ${d.id}, ${d.client_id ?? "NULL"}, ${amt}, ${q(isYmd(date) ? date : (d.paid_date || myToday()))}, 'Bank transfer', ${q(ref || d.payment_ref)})`);
  const r = one(`SELECT * FROM receipts WHERE number = ${q(no)}`);
  console.log(`${no}: RM ${money(amt)} received for ${d.number}. Client link: ${link(r.token)}   Admin: ${SITE}/admin/receipt/${r.id}`);
}

// ---------- books ----------
function expenseAdd(file) {
  const e = JSON.parse(readFileSync(file, "utf8"));
  const cat = EXPENSE_CATEGORIES.find(c => c.key === e.category);
  if (!cat) throw new Error(`category must be one of: ${EXPENSE_CATEGORIES.map(c => c.key).join(", ")}`);
  if (!isYmd(e.spent_date) || !e.vendor || !(toSen(e.amount) > 0)) throw new Error("spent_date, vendor and amount are required");
  const reimb = ["no", "to_bill", "reimbursed"].includes(e.reimbursed) ? e.reimbursed : "no";
  const client = e.client ? one(`SELECT id FROM clients WHERE lower(company) = lower(${q(e.client)}) OR lower(name) = lower(${q(e.client)}) LIMIT 1`) : null;
  if (e.client && !client) throw new Error(`no client called ${e.client}`);
  const r = one(`INSERT INTO expenses (spent_date, vendor, description, category, amount_sen, paid_from, reimbursed, client_id, reimbursed_date, deductible_pct, file, notes)
     VALUES (${q(e.spent_date)}, ${q(e.vendor)}, ${q(e.description)}, ${q(cat.key)}, ${toSen(e.amount)}, ${q(e.paid_from === "personal" ? "personal" : "business")}, ${q(reimb)},
     ${client ? client.id : "NULL"}, ${q(isYmd(e.reimbursed_date) ? e.reimbursed_date : "")}, ${n(e.deductible_pct ?? cat.pct)}, ${q(e.file)}, ${q(e.notes)}) RETURNING id`);
  console.log(`Expense #${r.id}: ${e.spent_date} ${e.vendor} RM ${money(toSen(e.amount))} (${cat.en}${reimb !== "no" ? ", " + reimb : ""})`);
}

function expenseList(year) {
  const y = /^\d{4}$/.test(year || "") ? year : myToday().slice(0, 4);
  const rows = sql(`SELECT e.*, COALESCE(c.company, c.name) AS client FROM expenses e LEFT JOIN clients c ON c.id = e.client_id WHERE e.spent_date LIKE '${y}-%' ORDER BY e.spent_date, e.id`);
  if (!rows.length) return console.log("(no expenses)");
  console.table(rows.map(e => ({ id: e.id, date: e.spent_date, vendor: e.vendor, what: (e.description || "").slice(0, 30), category: e.category,
    paid: money(e.amount_sen), deductible: money(deductibleSen(e)), reimbursed: e.reimbursed === "no" ? "" : `${e.reimbursed} ${e.client || ""}` })));
}

function books(year) {
  const y = /^\d{4}$/.test(year || "") ? year : myToday().slice(0, 4);
  const pays = sql(`SELECT * FROM payments WHERE paid_date LIKE '${y}-%'`);
  const exps = sql(`SELECT * FROM expenses WHERE spent_date LIKE '${y}-%'`);
  const unpaid = one("SELECT COALESCE(SUM(COALESCE(bill_sen,total_sen) - paid_sen),0) AS s FROM docs WHERE kind='invoice' AND status='sent'").s;
  const rows = [];
  for (let m = 1; m <= 12; m++) {
    const mm = `${y}-${String(m).padStart(2, "0")}`;
    const inc = pays.filter(p => p.paid_date.startsWith(mm)).reduce((a, p) => a + p.amount_sen, 0);
    const exp = exps.filter(e => e.spent_date.startsWith(mm)).reduce((a, e) => a + deductibleSen(e), 0);
    if (inc || exp) rows.push({ month: mm, received: money(inc), expenses: money(exp), profit: money(inc - exp) });
  }
  const inc = pays.reduce((a, p) => a + p.amount_sen, 0), ded = exps.reduce((a, e) => a + deductibleSen(e), 0);
  console.log(`Books ${y}: received RM ${money(inc)}, deductible expenses RM ${money(ded)}, profit RM ${money(inc - ded)}; unpaid invoices now RM ${money(unpaid)}`);
  if (rows.length) console.table(rows);
}

// Export the whole live database (one file per day, last 90 days kept) plus a readable snapshot of the numbering.
const KEEP_DAYS = 90;
function backup() {
  if (LOCAL) throw new Error("backup only runs against the live database");
  const dir = join(EXPORT, "backups");
  mkdirSync(dir, { recursive: true });
  const day = myToday();
  const tmp = join(tmpdir(), `billing-db_${day}_${process.pid}.sql`);
  execFileSync(process.execPath, [wranglerCli(), "d1", "export", DB, "--remote", `--output=${tmp}`],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const size = statSync(tmp).size;
  const text = readFileSync(tmp, "utf8");
  if (size < 200 || !text.includes("CREATE TABLE") || !text.includes("counters")) throw new Error("backup file looks incomplete; kept the previous backups untouched");
  const file = join(dir, `billing-db_${day}.sql`);
  copyFileSync(tmp, file);
  unlinkSync(tmp);
  const counters = sql("SELECT name, value FROM counters ORDER BY name");
  const counts = one(`SELECT (SELECT COUNT(*) FROM docs) AS docs, (SELECT COUNT(*) FROM receipts) AS receipts, (SELECT COUNT(*) FROM clients) AS clients,
      (SELECT MAX(number) FROM docs WHERE kind='quote') AS last_quote, (SELECT MAX(number) FROM docs WHERE kind='invoice') AS last_invoice,
      (SELECT MAX(number) FROM receipts) AS last_receipt`);
  writeFileSync(join(dir, "latest-numbers.txt"), [
    `Backup time (UTC+8): ${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ")}`,
    `Latest backup: billing-db_${day}.sql (${Math.round(size / 1024)} KB)`, "",
    "Numbering counters (next number = value + 1):", ...counters.map(x => `  ${x.name}: ${x.value}`), "",
    `Last quotation: ${counts.last_quote || "-"}`, `Last invoice: ${counts.last_invoice || "-"}`, `Last receipt: ${counts.last_receipt || "-"}`,
    `${counts.docs} documents, ${counts.receipts} receipts, ${counts.clients} clients`, "",
  ].join("\n"), "utf8");
  const cutoff = addDays(day, -KEEP_DAYS);
  let removed = 0;
  for (const f of readdirSync(dir)) {
    const m = f.match(/^billing-db_(\d{4}-\d{2}-\d{2})\.sql$/);
    if (m && m[1] < cutoff) { unlinkSync(join(dir, f)); removed++; }
  }
  console.log(`Backup: ${file} (${Math.round(size / 1024)} KB)${removed ? `, removed ${removed} older than ${KEEP_DAYS} days` : ""}`);
}

// PDFs of every sent document plus income.csv, into ./exports (point BILLING_EXPORT_DIR at a synced Google Drive / OneDrive folder if you like).
function sync() {
  if (!LOCAL) backup();
  const chrome = chromePath();
  const s = settings();
  const docs = sql(`SELECT * FROM docs WHERE status != 'draft' ORDER BY id`);
  const clients = Object.fromEntries(sql("SELECT * FROM clients").map(r => [r.id, r]));
  const numbers = Object.fromEntries(docs.map(d => [d.id, d.number]));
  const tmp = join(tmpdir(), `billing-sync-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  const safe = t => String(t || "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  const print = (html, pdf) => {
    const file = join(tmp, "doc.html");
    writeFileSync(file, html, "utf8");
    execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdf}`, "file:///" + file.replace(/\\/g, "/")], { stdio: "ignore", timeout: 60000 });
    console.log(`PDF  ${pdf}`);
  };
  let made = 0;
  for (const d of docs) {
    const cl = clients[d.client_id] || {};
    const folder = join(EXPORT, d.kind === "invoice" ? "invoices" : "quotes");
    mkdirSync(folder, { recursive: true });
    const pdf = join(folder, `${d.number}_${safe(cl.company || cl.name) || "client"}.pdf`);
    if (existsSync(pdf) && d.synced_at && d.synced_at >= d.updated_at) continue;
    print(renderDoc(d, cl, s, { quoteNumber: numbers[d.quote_id] }), pdf);
    sql(`UPDATE docs SET synced_at = datetime('now') WHERE id = ${d.id}`);
    made++;
  }
  const receipts = sql("SELECT * FROM receipts ORDER BY id");
  const docsById = Object.fromEntries(docs.map(d => [d.id, d]));
  for (const rc of receipts) {
    const cl = clients[rc.client_id] || {};
    const folder = join(EXPORT, "receipts");
    mkdirSync(folder, { recursive: true });
    const pdf = join(folder, `${rc.number}_${safe(cl.company || cl.name) || "client"}.pdf`);
    if (existsSync(pdf) && rc.synced_at && rc.status === "issued") continue;
    const toDate = receipts.filter(r => r.invoice_id === rc.invoice_id && r.id <= rc.id && r.status !== "void").reduce((x, r) => x + r.amount_sen, 0);
    print(renderReceipt(rc, docsById[rc.invoice_id], cl, s, { receivedToDate: toDate }), pdf);
    sql(`UPDATE receipts SET synced_at = datetime('now') WHERE id = ${rc.id}`);
    made++;
  }
  // income.csv: every invoice that is not void (the "paid" column is your income for the tax return).
  const csv = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["invoice", "date", "client", "subject", "type", "quotation", "billed_rm", "paid_rm", "balance_rm", "paid_date", "status"].join(",")];
  for (const d of docs.filter(x => x.kind === "invoice" && x.status !== "void")) {
    const cl = clients[d.client_id] || {};
    const x = invoiceAmounts(d);
    lines.push([d.number, d.issue_date, cl.company || cl.name, d.title, d.invoice_type || "full", numbers[d.quote_id] || "",
      (x.bill / 100).toFixed(2), (x.paid / 100).toFixed(2), (x.balance / 100).toFixed(2), d.paid_date || "", STATUS.invoice[d.status]].map(csv).join(","));
  }
  mkdirSync(EXPORT, { recursive: true });
  writeFileSync(join(EXPORT, "income.csv"), "\uFEFF" + lines.join("\r\n") + "\r\n", "utf8");
  // expenses.csv: every expense, with the deductible part (reimbursed ones count 0).
  const exp = [["date", "vendor", "description", "category", "amount_rm", "deductible_rm", "paid_from", "reimbursed", "client", "file"].join(",")];
  for (const e of sql(`SELECT e.*, COALESCE(c.company, c.name) AS client FROM expenses e LEFT JOIN clients c ON c.id = e.client_id ORDER BY e.spent_date, e.id`)) {
    exp.push([e.spent_date, e.vendor, e.description, categoryName(e.category), (e.amount_sen / 100).toFixed(2), (deductibleSen(e) / 100).toFixed(2),
      e.paid_from, e.reimbursed, e.client, e.file].map(csv).join(","));
  }
  writeFileSync(join(EXPORT, "expenses.csv"), "\uFEFF" + exp.join("\r\n") + "\r\n", "utf8");
  rmSync(tmp, { recursive: true, force: true });
  console.log(`Synced: ${made} PDF(s) updated, ${lines.length - 1} invoice(s) in ${join(EXPORT, "income.csv")}`);
}

try {
  switch (cmd) {
    case "list": list(a); break;
    case "show": show(a); break;
    case "new": newDoc(a, b); break;
    case "send": send(a); break;
    case "invoice": invoiceFrom(a, b); break;
    case "paid": paid(a, b, c, rest.join(" ")); break;
    case "receipt": receipt(a, b, c, rest.join(" ")); break;
    case "sync": sync(); break;
    case "backup": backup(); break;
    case "expense": if (a === "add") expenseAdd(b); else expenseList(b); break;
    case "books": books(a); break;
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter(l => l.startsWith("//")).slice(0, 25).map(l => l.slice(3)).join("\n"));
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
