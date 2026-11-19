// Plain-text email to the owner through Cloudflare Email Routing (send_email binding NOTIFY).
// MAIL_FROM must be an address on a domain that uses Email Routing; OWNER_EMAIL must be a verified destination.
import { EmailMessage } from "cloudflare:email";

const b64 = s => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

export async function notify(env, subject, text, fromName = "Billing") {
  if (!env.NOTIFY || !env.MAIL_FROM || !env.OWNER_EMAIL) return;
  const raw = [
    `From: ${fromName} <${env.MAIL_FROM}>`, `To: ${env.OWNER_EMAIL}`, `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Message-ID: <${crypto.randomUUID()}@${env.MAIL_FROM.split("@")[1]}>`, `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    b64(text).replace(/(.{76})/g, "$1\r\n"),
  ].join("\r\n");
  await env.NOTIFY.send(new EmailMessage(env.MAIL_FROM, env.OWNER_EMAIL, raw));
}
