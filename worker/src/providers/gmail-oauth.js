/**
 * Gmail API provider — OAuth, sends as info@emoexai.com.
 *
 * ⚠️ NOT the live path. MAIL_PROVIDER=gmail uses providers/gmail.js (SMTP +
 * App Password) instead. Kept because it is the one way to send from this
 * mailbox with a send-only credential: an App Password unlocks everything
 * that account can do, this unlocks `gmail.send` and nothing else. Switch to
 * it with MAIL_PROVIDER=gmail-oauth if that trade ever looks worth the setup.
 *
 * Gmail has three sending paths and only one of them is reachable from here:
 * smtp.gmail.com and smtp-relay.gmail.com are SMTP, which a Worker cannot
 * practically speak (no mature client for this runtime, port 25 blocked, and
 * the whole STARTTLS/AUTH conversation would be hand-rolled over
 * `cloudflare:sockets`). The REST API is plain HTTPS, so that is what this
 * uses. Note the relay's higher quota is *only* reachable over SMTP — this
 * path gets the ordinary per-user limit, which is what makes the daily
 * budget in mailer.js load-bearing rather than decorative.
 *
 * Auth is an OAuth refresh token for a single account, scoped to
 * `gmail.send` and nothing else. The alternative — a service account with
 * domain-wide delegation — would put a credential in Cloudflare that can
 * impersonate any user in the Workspace; this one can send mail as one
 * mailbox and do nothing else.
 *
 * Docs: https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send
 */

import { sequentialSendMany } from "../mailer.js";
import { buildMime, base64Url } from "./mime.js";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

// Refresh early so a token cannot expire midway through a fan-out.
const TOKEN_SKEW_S = 120;

// Isolate-local, keyed on the refresh token. A 100-message fan-out costs one
// token exchange instead of 100. Holds only our own service credential.
let cachedToken = null;

export function createGmailOauthMailer(env) {
  const creds = {
    clientId: env.GMAIL_CLIENT_ID,
    clientSecret: env.GMAIL_CLIENT_SECRET,
    refreshToken: env.GMAIL_REFRESH_TOKEN,
  };
  const from = env.MAIL_FROM;

  if (!creds.clientId || !creds.clientSecret || !creds.refreshToken || !from) {
    console.error("MAIL_PROVIDER=gmail-oauth but GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN or MAIL_FROM is missing");
    return {
      name: "gmail-oauth",
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
    const token = await accessToken(creds);
    if (!token.ok) return { ok: false, error: token.error };

    const response = await fetch(SEND_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${token.value}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: base64Url(buildMime(from, mail)) }),
    });

    if (response.ok) return { ok: true };

    const detail = (await response.text()).slice(0, 300);

    // The quota wall. Worth its own branch and a loud log because the blast
    // radius is not this mailing list — it is info@ being unable to send
    // anything at all for the rest of the day.
    if (response.status === 429 || detail.includes("rateLimitExceeded")) {
      console.error("gmail quota exhausted — info@ is likely locked for ~24h", detail);
      return { ok: false, error: `quota_exhausted ${detail}` };
    }

    // A revoked or expired refresh token shows up here as 401. Drop the cache
    // so the next attempt re-exchanges instead of replaying a dead token.
    if (response.status === 401) cachedToken = null;

    return { ok: false, error: `${response.status} ${detail}` };
  }

  // Gmail has no batch endpoint that helps: the generic /batch transport is
  // being retired and every inner request costs its own quota anyway.
  return { name: "gmail-oauth", configured: true, send, sendMany: sequentialSendMany(send) };
}

async function accessToken(creds) {
  const now = Date.now();
  if (cachedToken && cachedToken.key === creds.refreshToken && cachedToken.expiresAt > now) {
    return { ok: true, value: cachedToken.value };
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    // Never cache a failure: a revoked token has to be retried, not remembered.
    return { ok: false, error: `oauth ${response.status} ${(await response.text()).slice(0, 200)}` };
  }

  const body = await response.json();
  cachedToken = {
    key: creds.refreshToken,
    value: body.access_token,
    expiresAt: now + Math.max(0, (body.expires_in || 3600) - TOKEN_SKEW_S) * 1000,
  };
  return { ok: true, value: body.access_token };
}
