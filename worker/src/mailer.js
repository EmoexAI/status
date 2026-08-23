/**
 * Mail delivery adapter.
 *
 * Plugging a provider in is a contained change: write a module exposing
 * `send` / `sendMany`, register it in `createMailer`, set MAIL_PROVIDER.
 * Nothing else in the worker knows who delivers mail.
 *
 * With no provider set the worker still runs end to end and reports
 * `subscribe_enabled: false` on /api/health, which is what keeps the status
 * page from rendering a form that cannot work.
 *
 * Every mailer is wrapped in `withDailyBudget`, so the ceiling applies to
 * whoever delivers — see that function for why it fails closed.
 *
 * @typedef {Object} OutgoingMail
 * @property {string} to
 * @property {string} subject
 * @property {string} html
 * @property {string} text
 * @property {Record<string, string>} [headers]  e.g. List-Unsubscribe
 * @property {"transactional"|"broadcast"} [kind]  which daily ceiling applies;
 *   defaults to "transactional", the tighter of the two
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

import { createGmailMailer } from "./providers/gmail.js";
import { createGmailOauthMailer } from "./providers/gmail-oauth.js";
import { createResendMailer } from "./providers/resend.js";

/**
 * A provider must satisfy three things the status page depends on — check
 * them before picking one. (The EmoEx-Task Kotlin `sendText()` helper fails
 * 1 and 2 because it is a plain-text wrapper with no header support; that is
 * a limitation of that helper, not of Gmail. The Gmail API carries raw MIME
 * and does all three — see providers/gmail.js.)
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
    case "gmail":
      return withDailyBudget(createGmailMailer(env), env);
    case "gmail-oauth":
      return withDailyBudget(createGmailOauthMailer(env), env);
    case "resend":
      return withDailyBudget(createResendMailer(env), env);
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

/**
 * Hard daily ceiling, enforced before anything reaches the provider.
 *
 * This is not a cost control. Gmail's per-user limit is a wall: crossing it
 * locks the *account* for roughly 24 hours, and the account is
 * info@emoexai.com — the mailbox the company actually uses. Without this,
 * a public form on the status page is a self-serve outage for company email.
 *
 * Two ceilings, because one is not enough:
 *
 *   MAIL_DAILY_CAP            everything
 *   MAIL_DAILY_CAP_SUBSCRIBE  confirmation mail only (a subset of the above)
 *
 * The second exists because /api/subscribe is the attacker-reachable path.
 * With only a total cap, anyone hammering the form burns the whole day's
 * budget on confirmations and leaves nothing for the incident notice — which
 * downgrades "info@ is locked" into "outage alerts stop going out", the one
 * failure this project exists to prevent. Broadcasts spend only against the
 * total, so a flooded form can never fully starve them.
 *
 * ⚠️ The window is a fixed UTC day, not rolling. A burst straddling midnight
 * can therefore put up to 2x the cap into a single rolling 24h period — keep
 * MAIL_DAILY_CAP at or below half the provider's real limit.
 *
 * @param {Mailer} mailer
 * @param {Record<string, string>} env
 * @returns {Mailer}
 */
export function withDailyBudget(mailer, env) {
  const total = Number(env.MAIL_DAILY_CAP || 0);
  if (!mailer.configured || !Number.isFinite(total) || total <= 0) return mailer;

  const subscribeCap = Number(env.MAIL_DAILY_CAP_SUBSCRIBE || 0) || total;

  /**
   * Broadcasts spend against the total only; confirmations against both.
   *
   * Every budget consulted has to end up holding the *same* number of slots,
   * so anything a looser budget granted beyond the final figure is refunded.
   * Skipping that refund would let each confirmation refused by the sub-cap
   * still burn a slot of the total — which is precisely the starvation the
   * sub-cap exists to prevent. The sub-cap is checked first so the common
   * refusal costs no reservation at all.
   */
  async function grant(kind, wanted) {
    const budgets =
      kind === "broadcast"
        ? [["mail:daily", total]]
        : [["mail:daily:subscribe", subscribeCap], ["mail:daily", total]];

    const held = [];
    let granted = wanted;

    for (const [key, limit] of budgets) {
      const got = await reserve(env, key, limit, granted);
      held.push([key, got]);
      granted = Math.min(granted, got);
      if (granted === 0) break;
    }

    for (const [key, got] of held) {
      if (got > granted) await refund(env, key, got - granted);
    }

    return granted;
  }

  async function send(mail) {
    if ((await grant(mail.kind === "broadcast" ? "broadcast" : "transactional", 1)) === 0) {
      return { ok: false, error: "daily_cap_reached" };
    }
    return mailer.send(mail);
  }

  async function sendMany(mails) {
    if (mails.length === 0) return { sent: 0, failures: [] };

    const kind = mails[0].kind === "broadcast" ? "broadcast" : "transactional";
    const granted = await grant(kind, mails.length);

    if (granted < mails.length) {
      console.error(
        `daily mail cap: sending ${granted}/${mails.length} — the rest is dropped, not queued`
      );
    }
    if (granted === 0) {
      return { sent: 0, failures: mails.map((m) => ({ to: m.to, error: "daily_cap_reached" })) };
    }

    const result = await mailer.sendMany(mails.slice(0, granted));
    return {
      sent: result.sent,
      failures: [
        ...result.failures,
        ...mails.slice(granted).map((m) => ({ to: m.to, error: "daily_cap_reached" })),
      ],
    };
  }

  return { name: mailer.name, configured: true, send, sendMany };
}

/**
 * Claim up to `wanted` slots from a fixed-window counter, returning how many
 * were actually granted. Slots are claimed *before* sending, so a provider
 * failure over-counts — the safe direction when the downside of undercounting
 * is a locked mailbox.
 *
 * ⚠️ Fails CLOSED, unlike the request rate limiter in index.js, which fails
 * open so a limiter outage cannot take the subscribe form down. The trade is
 * the other way around here: if we cannot prove there is budget left, sending
 * anyway risks locking info@ for everyone.
 */
async function reserve(env, key, limit, wanted) {
  const windowStart = Math.floor(Date.now() / 1000 / 86400) * 86400;
  try {
    const row = await env.DB.prepare(
      "INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(key) DO UPDATE SET " +
        "count = CASE WHEN rate_limits.window_start = ?2 THEN rate_limits.count + ?3 ELSE ?3 END, " +
        "window_start = ?2 " +
        "RETURNING count"
    )
      .bind(key, windowStart, wanted)
      .first();

    if (!row) return 0;

    const overshoot = row.count - limit;
    if (overshoot <= 0) return wanted;

    // Hand back what did not fit so the counter keeps reflecting mail we
    // actually intend to send, rather than drifting up on every refusal.
    const granted = Math.max(0, wanted - overshoot);
    await refund(env, key, wanted - granted);
    return granted;
  } catch (error) {
    console.error("daily mail budget unavailable — refusing to send", error);
    return 0;
  }
}

/**
 * Release slots claimed by `reserve` that will not be used. Best-effort: a
 * failure here only leaves the day's counter running high, which errs toward
 * sending less mail — the safe direction.
 */
async function refund(env, key, count) {
  if (count <= 0) return;
  const windowStart = Math.floor(Date.now() / 1000 / 86400) * 86400;
  try {
    await env.DB.prepare(
      "UPDATE rate_limits SET count = count - ?2 WHERE key = ?1 AND window_start = ?3"
    )
      .bind(key, count, windowStart)
      .run();
  } catch (error) {
    console.error("daily mail budget refund failed; counter runs high until midnight", error);
  }
}
