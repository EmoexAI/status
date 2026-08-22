/**
 * Resend provider — a worked reference implementation of the Mailer contract.
 *
 * ⚠️ OFF BY DEFAULT and not a vendor decision. MAIL_PROVIDER defaults to
 * "none", so nothing here runs until someone deliberately sets
 * MAIL_PROVIDER=resend and RESEND_API_KEY. It is checked in so the shape of
 * a real provider is concrete rather than hypothetical: ~40 lines, three
 * requirements (HTML + text, custom headers, one message per recipient).
 * Delete this file and its `case` in mailer.js if you go elsewhere.
 *
 * Docs: https://resend.com/docs/api-reference/emails/send-email
 */

import { sequentialSendMany } from "../mailer.js";

const SEND_ENDPOINT = "https://api.resend.com/emails";
const BATCH_ENDPOINT = "https://api.resend.com/emails/batch";
const BATCH_LIMIT = 100; // Resend's hard cap per batch call.

export function createResendMailer(env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.MAIL_FROM;

  if (!apiKey || !from) {
    console.error("MAIL_PROVIDER=resend but RESEND_API_KEY or MAIL_FROM is missing");
    return {
      name: "resend",
      configured: false,
      async send() {
        return { ok: false, error: "mail_not_configured" };
      },
      async sendMany(mails) {
        return { sent: 0, failures: mails.map((m) => ({ to: m.to, error: "mail_not_configured" })) };
      },
    };
  }

  async function send(mail) {
    const response = await fetch(SEND_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(toResendMessage(from, mail)),
    });
    if (response.ok) return { ok: true };
    return { ok: false, error: `${response.status} ${(await response.text()).slice(0, 300)}` };
  }

  const sendOneByOne = sequentialSendMany(send);

  async function sendMany(mails) {
    let sent = 0;
    const failures = [];

    for (let i = 0; i < mails.length; i += BATCH_LIMIT) {
      const slice = mails.slice(i, i + BATCH_LIMIT);
      const response = await fetch(BATCH_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(slice.map((mail) => toResendMessage(from, mail))),
      });

      if (response.ok) {
        sent += slice.length;
        continue;
      }

      // Resend rejects the *entire* batch if any single address is invalid,
      // so one stale subscriber would otherwise silence an outage notice for
      // everybody. Retry the slice one message at a time.
      console.warn("resend batch failed, retrying individually:", response.status);
      const fallback = await sendOneByOne(slice);
      sent += fallback.sent;
      failures.push(...fallback.failures);
    }

    return { sent, failures };
  }

  return { name: "resend", configured: true, send, sendMany };
}

function toResendMessage(from, mail) {
  return {
    from,
    to: [mail.to],
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    headers: mail.headers,
  };
}
