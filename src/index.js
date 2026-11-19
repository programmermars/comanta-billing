// Quotations, invoices and receipts on Cloudflare Workers + D1.
//   /admin/...   owner-only pages (one-time code emailed to OWNER_EMAIL)
//   /d/<token>   the client's view of one document (print / save as PDF, accept a quotation)
//   scheduled()  daily database backup emailed to OWNER_EMAIL (cron in wrangler.jsonc)
import { handleBilling } from "./billing.js";
import { emailBackup } from "./backup.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") return Response.redirect(new URL("/admin", url).toString(), 302);
    try {
      const res = await handleBilling(request, env, ctx, url);
      if (res) return res;
    } catch (err) {
      console.error("billing failed", err);
      return new Response("Something went wrong. Please try again.", { status: 500, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(emailBackup(env).then(r => console.log("backup", JSON.stringify(r))).catch(err => console.error("backup failed", err)));
  },
};
