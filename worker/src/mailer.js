/**
 * Mail delivery adapter.
 *
 * No provider is wired up yet — sending is deliberately unimplemented. The
 * point of this file is that plugging one in is a contained change: write a
 * module exposing `send` / `sendMany`, register it in `createMailer`, set
 * MAIL_PROVIDER, done. Nothing else in the worker knows who delivers mail.
 *
 * Everything else — subscribe, double opt-in, unsubscribe, the subscriber
 * table, incident fan-out — is finished and runs without a provider. Until
 * one exists the worker reports `subscribe_enabled: false` on /api/health,
 * which is what keeps the status page from rendering a form that cannot work.
 *
 * @typedef {Object} OutgoingMail
 * @property {string} to
 * @property {string} subject
 * @property {string} html
 * @property {string} text
 * @property {Record<string, string>} [headers]  e.g. List-Unsubscribe
 *
 * @typedef {Object} SendResult
 * @property {boolean} ok
 * @property {string} [error]
 *
 * @typedef {Object} SendManyResult
 * @property {number} sent
 * @property {Array<{to: string, error: string}>} failures
 *
 * @typedef {Object} Mailer
 * @property {string} name
 * @property {boolean} configured
 * @property {(mail: OutgoingMail) => Promise<SendResult>} send
 * @property {(mails: OutgoingMail[]) => Promise<SendManyResult>} sendMany
 */

import { createResendMailer } from "./providers/resend.js";

/**
 * A provider must satisfy three things the status page depends on, none of
 * which the existing EmoEx-Task Gmail SMTP path can do (plain-text only, no
 * custom headers) — check them before picking one:
 *
 *   1. HTML body plus a plain-text alternative.
 *   2. Custom headers, specifically List-Unsubscribe and
 *      List-Unsubscribe-Post. Gmail and Yahoo require one-click unsubscribe
 *      from bulk senders; without it this list will land in spam.
 *   3. Per-recipient delivery. Never put subscribers in one To/Cc — that
 *      leaks the whole list to everyone on it.
 *
 * @param {Record<string, string>} env
 * @returns {Mailer}
 */
export function createMailer(env) {
  const provider = (env.MAIL_PROVIDER || "none").toLowerCase();

  switch (provider) {
    case "resend":
      return createResendMailer(env);
    case "none":
    case "":
      return createNullMailer();
    default:
      console.error("unknown MAIL_PROVIDER, falling back to none:", provider);
      return createNullMailer();
  }
}

/**
 * The default. Fails closed and loudly rather than pretending to deliver:
 * a mailing list that silently drops mail is worse than one that is visibly
 * switched off.
 *
 * @returns {Mailer}
 */
function createNullMailer() {
  return {
    name: "none",
    configured: false,
    async send() {
      return { ok: false, error: "mail_not_configured" };
    },
    async sendMany(mails) {
      return {
        sent: 0,
        failures: mails.map((mail) => ({ to: mail.to, error: "mail_not_configured" })),
      };
    },
  };
}

/**
 * Default `sendMany` for providers with no batch endpoint: send one at a
 * time and keep going past failures, so a single dead address cannot silence
 * an outage notice for everyone else.
 *
 * @param {(mail: OutgoingMail) => Promise<SendResult>} send
 * @returns {(mails: OutgoingMail[]) => Promise<SendManyResult>}
 */
export function sequentialSendMany(send) {
  return async function sendMany(mails) {
    let sent = 0;
    const failures = [];
    for (const mail of mails) {
      const result = await send(mail);
      if (result.ok) sent += 1;
      else failures.push({ to: mail.to, error: result.error || "unknown_error" });
    }
    return { sent, failures };
  };
}
