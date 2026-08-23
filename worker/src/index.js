/**
 * EmoEx Status — MailList worker.
 *
 * Public email subscription list for https://status.emoexai.com. Visitors
 * subscribe on the status page; when an incident opens or closes, GitHub
 * Actions calls POST /api/notify and this worker fans the news out.
 *
 * Deliberately on Cloudflare and not in GKE: the point of the status page is
 * to keep working during a full GCP outage, which is exactly when subscribers
 * need the mail. Putting the notifier on the infrastructure it reports on
 * would make it fail at the only moment it matters.
 *
 * ⚠️ No mail provider is wired up yet (MAIL_PROVIDER defaults to "none").
 * Everything else works; sending is a contained adapter — see mailer.js.
 * While unconfigured, /api/health advertises subscribe_enabled:false and the
 * status page keeps the subscribe card hidden, so nothing user-facing breaks.
 *
 * Routes
 *   GET    /api/health                       → { ok, subscribe_enabled }
 *   POST   /api/subscribe                    → double opt-in, sends confirm mail
 *   GET    /api/confirm?token=...            → confirms, renders an HTML page
 *   GET    /api/unsubscribe?token=...        → renders an HTML page
 *   POST   /api/unsubscribe?token=...        → RFC 8058 one-click, returns JSON
 *   POST   /api/notify        (Bearer auth)  → fan-out to confirmed subscribers
 */

import { createMailer } from "./mailer.js";

// Deliberately loose: the authoritative check is whether the confirmation
// mail actually arrives. This only rejects input that cannot be an address.
const EMAIL_RE = /^[^\s@,;:<>"]+@[^\s@,;:<>"]+\.[^\s@,;:<>"]{2,}$/;

const SUBSCRIBE_PER_IP_PER_HOUR = 5;
const SUBSCRIBE_GLOBAL_PER_HOUR = 200;
const CONFIRM_RESEND_COOLDOWN_S = 300; // 5 min between confirmation re-sends
const FANOUT_CHUNK = 100;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(env, origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const response = await route(request, env, url);
      for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
      return response;
    } catch (error) {
      console.error("unhandled error", error && error.stack ? error.stack : error);
      return json({ ok: false, error: "internal_error" }, { status: 500, headers: cors });
    }
  },
};

async function route(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const mailer = createMailer(env);

  if (request.method === "GET" && (path === "/api/health" || path === "/")) {
    // The status page polls this before revealing the subscribe form. Keep
    // `subscribe_enabled` honest — it is what stops the page from offering a
    // form that would drop the address on the floor.
    return json({
      ok: true,
      service: "emoex-status-maillist",
      subscribe_enabled: mailer.configured,
    });
  }
  if (request.method === "POST" && path === "/api/subscribe") {
    return handleSubscribe(request, env, mailer);
  }
  if (request.method === "GET" && path === "/api/confirm") {
    return handleConfirm(url, env);
  }
  if (path === "/api/unsubscribe" && (request.method === "GET" || request.method === "POST")) {
    return handleUnsubscribe(request, url, env);
  }
  if (request.method === "POST" && path === "/api/notify") {
    return handleNotify(request, env, mailer);
  }
  return json({ ok: false, error: "not_found" }, { status: 404 });
}

/* ------------------------------------------------------------------ */
/* Subscribe                                                           */
/* ------------------------------------------------------------------ */

async function handleSubscribe(request, env, mailer) {
  // Refuse before touching the database. Storing an address we can never
  // confirm would leave a pending row that silently expires — worse than an
  // honest "not open yet".
  if (!mailer.configured) {
    return json({ ok: false, error: "subscriptions_closed" }, { status: 503 });
  }

  const body = await readBody(request);
  const email = normalizeEmail(body.email);

  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return json({ ok: false, error: "invalid_email" }, { status: 400 });
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const withinIpLimit = await rateLimit(env, `sub:ip:${ip}`, SUBSCRIBE_PER_IP_PER_HOUR, 3600);
  const withinGlobalLimit = await rateLimit(env, "sub:global", SUBSCRIBE_GLOBAL_PER_HOUR, 3600);
  if (!withinIpLimit || !withinGlobalLimit) {
    return json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  const nowIso = new Date().toISOString();
  const nowUnix = Math.floor(Date.now() / 1000);

  const existing = await env.DB.prepare(
    "SELECT id, status, confirm_token, last_sent_at FROM subscribers WHERE email = ?1"
  )
    .bind(email)
    .first();

  let confirmToken;

  if (existing) {
    // Already on the list. Say nothing that would confirm the address exists,
    // and above all do not mail them again.
    if (existing.status === "confirmed") return genericSubscribeOk();

    // Pending or previously unsubscribed: re-send the confirmation, but only
    // outside the cooldown — otherwise this form is an open mail-bomb relay
    // pointed at whatever address the attacker types.
    if (nowUnix - existing.last_sent_at < CONFIRM_RESEND_COOLDOWN_S) return genericSubscribeOk();

    confirmToken = existing.confirm_token;
    await env.DB.prepare(
      "UPDATE subscribers SET status = 'pending', unsubscribed_at = NULL WHERE id = ?1"
    )
      .bind(existing.id)
      .run();
  } else {
    confirmToken = newToken();
    await env.DB.prepare(
      "INSERT INTO subscribers (email, status, confirm_token, unsubscribe_token, created_at, last_sent_at) " +
        "VALUES (?1, 'pending', ?2, ?3, ?4, 0)"
    )
      .bind(email, confirmToken, newToken(), nowIso)
      .run();
  }

  const confirmUrl = `${apiBase(env)}/api/confirm?token=${confirmToken}`;
  const result = await mailer.send({
    to: email,
    subject: `Confirm your ${brand(env)} subscription`,
    html: confirmHtml(env, confirmUrl),
    text: confirmText(env, confirmUrl),
    // Reachable by anyone with the form, so it spends against the tighter of
    // the two daily ceilings — see withDailyBudget in mailer.js.
    kind: "transactional",
  });

  if (!result.ok) {
    console.error("confirmation send failed", result.error);
    return json({ ok: false, error: "send_failed" }, { status: 502 });
  }

  // Only now — the cooldown gates *sent* mail. Stamping it before the send
  // would mean a transient provider failure locks the address out for five
  // minutes while telling the next attempt "check your inbox", with nothing
  // ever delivered.
  await env.DB.prepare("UPDATE subscribers SET last_sent_at = ?2 WHERE email = ?1")
    .bind(email, nowUnix)
    .run();

  return genericSubscribeOk();
}

// One response for "new address", "already pending" and "already confirmed",
// so the endpoint cannot be used to test whether an address is on the list.
function genericSubscribeOk() {
  return json({
    ok: true,
    message: "Check your inbox — we sent you a link to confirm the subscription.",
  });
}

/* ------------------------------------------------------------------ */
/* Confirm / unsubscribe                                               */
/* ------------------------------------------------------------------ */

async function handleConfirm(url, env) {
  const token = (url.searchParams.get("token") || "").trim();
  if (!token) return htmlPage(env, "Invalid link", "This confirmation link is missing its token.", 400);

  const row = await env.DB.prepare("SELECT id, status FROM subscribers WHERE confirm_token = ?1")
    .bind(token)
    .first();

  if (!row) {
    return htmlPage(env, "Link not recognised", "This confirmation link is not valid. Try subscribing again.", 404);
  }
  // The token is kept rather than consumed, so a second click reads as
  // "already done" instead of a dead link.
  if (row.status === "confirmed") {
    return htmlPage(env, "Already confirmed", "You are on the list — nothing more to do.");
  }

  await env.DB.prepare(
    "UPDATE subscribers SET status = 'confirmed', confirmed_at = ?2, unsubscribed_at = NULL WHERE id = ?1"
  )
    .bind(row.id, new Date().toISOString())
    .run();

  return htmlPage(
    env,
    "Subscription confirmed",
    "You will get an email whenever an EmoEx service goes down or recovers. Every message carries an unsubscribe link."
  );
}

async function handleUnsubscribe(request, url, env) {
  const token = (url.searchParams.get("token") || "").trim();
  const oneClick = request.method === "POST"; // RFC 8058

  if (!token) {
    return oneClick
      ? json({ ok: false, error: "missing_token" }, { status: 400 })
      : htmlPage(env, "Invalid link", "This unsubscribe link is missing its token.", 400);
  }

  const result = await env.DB.prepare(
    "UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ?2 WHERE unsubscribe_token = ?1"
  )
    .bind(token, new Date().toISOString())
    .run();

  const matched = result.meta && result.meta.changes > 0;

  // Mail clients retry one-click unsubscribe on non-2xx, so an unknown token
  // still answers 200 there.
  if (oneClick) return json({ ok: true });

  return matched
    ? htmlPage(env, "Unsubscribed", "You will not receive any further status emails. You can resubscribe at any time.")
    : htmlPage(env, "Link not recognised", "This unsubscribe link is not valid — you may already be unsubscribed.", 404);
}

/* ------------------------------------------------------------------ */
/* Notify                                                              */
/* ------------------------------------------------------------------ */

async function handleNotify(request, env, mailer) {
  const auth = request.headers.get("Authorization") || "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.NOTIFY_SECRET || !timingSafeEqual(presented, env.NOTIFY_SECRET)) {
    return json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const payload = await readBody(request);
  const action = payload.action === "closed" ? "closed" : "opened";
  const number = Number(payload.number);
  const title = String(payload.title || "").slice(0, 200);
  const issueUrl = String(payload.url || "");

  if (!Number.isFinite(number) || !title) {
    return json({ ok: false, error: "invalid_payload" }, { status: 400 });
  }

  // Answer 200 while no provider is configured: the incident hook firing on
  // every open/close is correct behaviour, and turning maillist-notify.yml
  // permanently red would just train everyone to ignore it. Note that the
  // idempotency key is NOT claimed here, so the first real send still works.
  if (!mailer.configured) {
    console.warn("notify skipped: no mail provider configured");
    return json({ ok: true, skipped: true, reason: "mail_not_configured", sent: 0 });
  }

  // Claim the (issue, action) pair before sending. A workflow re-run replays
  // the same event, and without this every re-run mails the whole list again.
  const key = `${number}:${action}`;
  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO notifications (key, sent_at, recipients) VALUES (?1, ?2, 0)"
  )
    .bind(key, new Date().toISOString())
    .run();

  if (!claim.meta || claim.meta.changes === 0) {
    return json({ ok: true, skipped: true, reason: "already_sent" });
  }

  const { results } = await env.DB.prepare(
    "SELECT email, unsubscribe_token FROM subscribers WHERE status = 'confirmed'"
  ).all();

  const recipients = results || [];
  if (recipients.length === 0) return json({ ok: true, sent: 0 });

  const subject = action === "closed" ? `[${brand(env)}] Resolved: ${title}` : `[${brand(env)}] ${title}`;

  // One message per recipient — never a shared To/Cc, which would leak the
  // entire subscriber list to everyone on it.
  const messages = recipients.map((row) => {
    const unsubUrl = `${apiBase(env)}/api/unsubscribe?token=${row.unsubscribe_token}`;
    return {
      to: row.email,
      subject,
      html: incidentHtml(env, { action, title, issueUrl, unsubUrl }),
      text: incidentText(env, { action, title, issueUrl, unsubUrl }),
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      // Spends against the total daily budget only, never the subscribe
      // sub-cap: a flooded form must not be able to starve outage notices.
      kind: "broadcast",
    };
  });

  let sent = 0;
  const failures = [];
  for (let i = 0; i < messages.length; i += FANOUT_CHUNK) {
    const result = await mailer.sendMany(messages.slice(i, i + FANOUT_CHUNK));
    sent += result.sent;
    failures.push(...result.failures);
  }

  if (sent === 0) {
    // Nothing went out — release the claim so a retry can actually work.
    await env.DB.prepare("DELETE FROM notifications WHERE key = ?1").bind(key).run();
    return json({ ok: false, error: "send_failed", failures: failures.slice(0, 5) }, { status: 502 });
  }

  await env.DB.prepare("UPDATE notifications SET recipients = ?2 WHERE key = ?1").bind(key, sent).run();
  return json({ ok: true, sent, failed: failures.length });
}

/* ------------------------------------------------------------------ */
/* Email bodies                                                        */
/* ------------------------------------------------------------------ */

const MAIL_WRAP = (inner) =>
  `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;` +
  `font-size:15px;line-height:1.6;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px">${inner}</div>`;

function confirmHtml(env, confirmUrl) {
  return MAIL_WRAP(
    `<h2 style="margin:0 0 16px;font-size:19px">Confirm your subscription</h2>` +
      `<p style="margin:0 0 20px">Someone — hopefully you — asked to receive ${escapeHtml(brand(env))} ` +
      `updates at this address. Confirm to start receiving them:</p>` +
      `<p style="margin:0 0 24px"><a href="${confirmUrl}" ` +
      `style="background:#0b7285;color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;display:inline-block">` +
      `Confirm subscription</a></p>` +
      `<p style="margin:0 0 8px;color:#666;font-size:13px">Or paste this link into your browser:<br>` +
      `<span style="word-break:break-all">${confirmUrl}</span></p>` +
      `<p style="margin:20px 0 0;color:#666;font-size:13px">If you did not request this, ignore this email — ` +
      `no subscription is created until the link above is clicked.</p>`
  );
}

function confirmText(env, confirmUrl) {
  return (
    `Confirm your ${brand(env)} subscription\n\n` +
    `Someone - hopefully you - asked to receive status updates at this address.\n` +
    `Open this link to confirm:\n\n${confirmUrl}\n\n` +
    `If you did not request this, ignore this email. No subscription is created\n` +
    `until the link is clicked.\n`
  );
}

function incidentHtml(env, { action, title, issueUrl, unsubUrl }) {
  const resolved = action === "closed";
  const accent = resolved ? "#2b8a3e" : "#c92a2a";
  const heading = resolved ? "Resolved" : "Incident opened";
  const statusUrl = statusSite(env);

  return MAIL_WRAP(
    `<p style="margin:0 0 6px;color:${accent};font-weight:600;font-size:13px;` +
      `text-transform:uppercase;letter-spacing:.04em">${heading}</p>` +
      `<h2 style="margin:0 0 16px;font-size:19px">${escapeHtml(title)}</h2>` +
      `<p style="margin:0 0 20px">${
        resolved
          ? "The affected service is responding normally again."
          : "We are seeing failures on this service. The status page tracks it live."
      }</p>` +
      `<p style="margin:0 0 24px"><a href="${statusUrl}" ` +
      `style="background:#0b7285;color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;display:inline-block">` +
      `View status page</a></p>` +
      (issueUrl
        ? `<p style="margin:0 0 24px;font-size:13px;color:#666">Incident details: ` +
          `<a href="${issueUrl}" style="color:#0b7285">${escapeHtml(issueUrl)}</a></p>`
        : "") +
      `<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0 12px">` +
      `<p style="margin:0;color:#888;font-size:12px">You subscribed to ${escapeHtml(brand(env))} ` +
      `at ${statusUrl}. <a href="${unsubUrl}" style="color:#888">Unsubscribe</a>.</p>`
  );
}

function incidentText(env, { action, title, issueUrl, unsubUrl }) {
  const resolved = action === "closed";
  return (
    `${resolved ? "RESOLVED" : "INCIDENT OPENED"}\n\n${title}\n\n` +
    `${
      resolved
        ? "The affected service is responding normally again."
        : "We are seeing failures on this service. The status page tracks it live."
    }\n\n` +
    `Status page: ${statusSite(env)}\n` +
    (issueUrl ? `Incident details: ${issueUrl}\n` : "") +
    `\n---\nUnsubscribe: ${unsubUrl}\n`
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function brand(env) {
  return env.BRAND_NAME || "EmoEx Status";
}
function apiBase(env) {
  return (env.API_BASE_URL || "").replace(/\/$/, "");
}
function statusSite(env) {
  return (env.STATUS_URL || "https://status.emoexai.com").replace(/\/$/, "");
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function readBody(request) {
  const contentType = request.headers.get("content-type") || "";
  try {
    if (contentType.includes("application/json")) return await request.json();
    if (contentType.includes("form")) return Object.fromEntries((await request.formData()).entries());
    return JSON.parse(await request.text());
  } catch {
    return {};
  }
}

function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

/**
 * Fixed-window counter in D1. Returns true while the caller is under `limit`.
 * Fails open: if the limiter itself errors we would rather let a request
 * through than take the subscribe form down.
 */
async function rateLimit(env, key, limit, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);
  try {
    const row = await env.DB.prepare(
      "INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1) " +
        "ON CONFLICT(key) DO UPDATE SET " +
        "count = CASE WHEN rate_limits.window_start = ?2 THEN rate_limits.count + 1 ELSE 1 END, " +
        "window_start = ?2 " +
        "RETURNING count"
    )
      .bind(key, windowStart)
      .first();
    return !row || row.count <= limit;
  } catch (error) {
    console.error("rate limiter failed open", error);
    return true;
  }
}

function corsHeaders(env, origin) {
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

function htmlPage(env, heading, message, status = 200) {
  const site = statusSite(env);
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(heading)} · ${escapeHtml(brand(env))}</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --muted:#666; --accent:#0b7285; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16191c; --fg:#e8eaed; --muted:#9aa0a6; --accent:#4dabf7; }
  }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:var(--bg); color:var(--fg);
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
  main { max-width:34rem; padding:2.5rem 1.5rem; text-align:center; }
  h1 { font-size:1.4rem; margin:0 0 .75rem; }
  p { color:var(--muted); line-height:1.6; margin:0 0 1.75rem; }
  a.button { display:inline-block; background:var(--accent); color:#fff; text-decoration:none;
             padding:.7rem 1.3rem; border-radius:.4rem; font-size:.95rem; }
</style>
</head>
<body>
  <main>
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(message)}</p>
    <a class="button" href="${site}">Back to ${escapeHtml(brand(env))}</a>
  </main>
</body>
</html>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
