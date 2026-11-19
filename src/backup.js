// Daily database backup by email (cron in wrangler.jsonc, or the "Email a backup now" button in /admin/settings).
// The attachment is plain SQL: restore into an empty database with
//   npx wrangler d1 execute billing-db --remote --file=billing-db_YYYY-MM-DD.sql
// Login codes and sessions are left out on purpose.
import { EmailMessage } from "cloudflare:email";

const SKIP = new Set(["admin_codes", "admin_sessions", "sqlite_sequence"]);

const lit = v => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");

export async function dumpSql(env) {
  const { results: tables } = await env.DB.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all();
  const { results: indexes } = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all();
  const out = [`-- billing-db backup ${new Date().toISOString()}`, "PRAGMA defer_foreign_keys = true;"];
  const counts = {};
  const keep = tables.filter(t => !SKIP.has(t.name));
  // All tables first, then the rows, so references between tables never point at a table that does not exist yet.
  for (const t of keep) out.push(`${t.sql.replace(/^CREATE TABLE (?!IF NOT EXISTS)/i, "CREATE TABLE IF NOT EXISTS ")};`);
  for (const t of keep) {
    const { results: rows } = await env.DB.prepare(`SELECT * FROM "${t.name}"`).all();
    counts[t.name] = rows.length;
    for (const r of rows) {
      const cols = Object.keys(r);
      out.push(`INSERT INTO "${t.name}" (${cols.map(c => `"${c}"`).join(",")}) VALUES (${cols.map(c => lit(r[c])).join(",")});`);
    }
  }
  for (const i of indexes) out.push(`${i.sql.replace(/^CREATE INDEX (?!IF NOT EXISTS)/i, "CREATE INDEX IF NOT EXISTS ")};`);
  return { sql: out.join("\n") + "\n", counts };
}

const b64 = s => {
  const bytes = typeof s === "string" ? new TextEncoder().encode(s) : s;
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const wrap = s => s.replace(/(.{76})/g, "$1\r\n");

export async function emailBackup(env) {
  if (!env.NOTIFY || !env.MAIL_FROM || !env.OWNER_EMAIL) return { ok: false, error: "email not configured" };
  const FROM = env.MAIL_FROM, TO = env.OWNER_EMAIL;
  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const { sql, counts } = await dumpSql(env);
  const { results: counters } = await env.DB.prepare("SELECT name, value FROM counters ORDER BY name").all();
  const last = await env.DB.prepare(`SELECT (SELECT MAX(number) FROM docs WHERE kind='quote') AS q, (SELECT MAX(number) FROM docs WHERE kind='invoice') AS i,
      (SELECT MAX(number) FROM receipts) AS r`).first();
  const subject = `[Billing backup] ${day}: ${counts.docs ?? 0} documents, ${counts.receipts ?? 0} receipts, ${counts.clients ?? 0} clients`;
  const text = [
    `Daily backup ${day} (attachment: billing-db_${day}.sql, ${Math.round(sql.length / 1024)} KB)`, "",
    "Numbering counters (next number = value + 1):", ...counters.map(c => `  ${c.name}: ${c.value}`), "",
    `Last quotation: ${last?.q || "-"}`, `Last invoice: ${last?.i || "-"}`, `Last receipt: ${last?.r || "-"}`, "",
    "Rows per table: " + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", "), "",
    'To restore, see "Backups and restore" in the README.',
    "This email contains client and bank details. Do not forward it.",
  ].join("\n");
  const boundary = "bk-" + crypto.randomUUID();
  const raw = [
    `From: Billing backup <${FROM}>`, `To: ${TO}`, `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Message-ID: <${crypto.randomUUID()}@${FROM.split("@")[1]}>`, `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap(b64(text)),
    `--${boundary}`, `Content-Type: application/sql; name="billing-db_${day}.sql"`, "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="billing-db_${day}.sql"`, "", wrap(b64(sql)),
    `--${boundary}--`, "",
  ].join("\r\n");
  await env.NOTIFY.send(new EmailMessage(FROM, TO, raw));
  return { ok: true, day, size: sql.length, counts };
}
