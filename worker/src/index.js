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
 * The live Wrangler config selects Gmail; sending remains a contained adapter
 * behind MAIL_PROVIDER — see mailer.js. If a deployment has no provider or is
 * missing its credentials, /api/health advertises subscribe_enabled:false and
 * the status page keeps the subscribe card hidden, so nothing user-facing
 * pretends to work.
 *
 * ⚠️ This worker serves no user-visible HTML. Everything a person sees lives
 * on status.emoexai.com, which is the page they already trust and the one that
 * stays up during an outage. Mail therefore links to
 * `status.emoexai.com/#subscription=<action>&token=<64hex>`, and the token
 * rides in the *fragment* — never sent to a server, so it stays out of the
 * status site's request logs and out of any Referer. The legacy GETs here only
 * redirect there; they mutate nothing, because a link preview, a mail scanner
 * or a prefetch must not be able to confirm or unsubscribe anyone.
 *
 * Routes
 *   GET    /api/health                       → { ok, subscribe_enabled }
 *   POST   /api/subscribe                    → double opt-in, sends confirm mail
 *   POST   /api/confirm       { token }      → pending → confirmed
 *   GET    /api/confirm?token=...            → 303 to the status page, no mutation
 *   POST   /api/unsubscribe   { token }      → from the status page, returns JSON
 *   POST   /api/unsubscribe?token=...        → RFC 8058 one-click (mail clients)
 *   GET    /api/unsubscribe?token=...        → 303 to the status page, no mutation
 *   POST   /api/notify        (Bearer auth)  → fan-out to confirmed subscribers
 */

import { createMailer } from "./mailer.js";

// Deliberately loose: the authoritative check is whether the confirmation
// mail actually arrives. This only rejects input that cannot be an address.
const EMAIL_RE = /^[^\s@,;:<>"]+@[^\s@,;:<>"]+\.[^\s@,;:<>"]{2,}$/;

// Exactly what newToken() produces. Checked before a token is put into a
// redirect or a query, so nothing else can be smuggled through those.
const TOKEN_RE = /^[0-9a-f]{64}$/;

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
  if (path === "/api/confirm" && (request.method === "GET" || request.method === "POST")) {
    return handleConfirm(request, url, env);
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

    if (existing.status === "unsubscribed") {
      // Coming back from an unsubscribe is the one case that needs a fresh
      // token. The unsubscribe rotated confirm_token precisely so no link
      // still sitting in an inbox could put this address back on the list;
      // handing that rotated value out again would undo that.
      confirmToken = newToken();

      // Conditional on the row still being unsubscribed, so two racing
      // resubscribes cannot both mint a token: the second UPDATE matches
      // nothing. Without the guard the loser would overwrite the winner's
      // token and both would mail, leaving the winner's link dead on arrival
      // — the row only keeps whichever token was written last.
      const revived = await env.DB.prepare(
        "UPDATE subscribers SET status = 'pending', unsubscribed_at = NULL, confirm_token = ?2 " +
          "WHERE id = ?1 AND status = 'unsubscribed'"
      )
        .bind(existing.id, confirmToken)
        .run();

      // Lost the race. The winner is mailing this same address right now, so
      // answer the usual generic success and send nothing.
      if (!revived.meta || revived.meta.changes === 0) return genericSubscribeOk();
    } else {
      // Still pending: re-send the link they already have and write nothing.
      // Rotating here buys no security — the row is already pending, so the
      // outstanding token grants exactly what this request is asking for —
      // and it costs plenty: if the send below fails we would have destroyed
      // the one working link in their inbox and delivered no replacement.
      // Writing nothing also means a confirm landing mid-request cannot be
      // knocked back to pending by a write that raced past it.
      confirmToken = existing.confirm_token;
    }
  } else {
    confirmToken = newToken();
    await env.DB.prepare(
      "INSERT INTO subscribers (email, status, confirm_token, unsubscribe_token, created_at, last_sent_at) " +
        "VALUES (?1, 'pending', ?2, ?3, ?4, 0)"
    )
      .bind(email, confirmToken, newToken(), nowIso)
      .run();
  }

  const confirmUrl = actionUrl(env, "confirm", confirmToken);
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

async function handleConfirm(request, url, env) {
  // GET is a link click: hand the token to the status page and mutate nothing.
  // Mail scanners, link previews and prefetchers all issue GETs, and any of
  // them would otherwise complete a double opt-in that no human ever agreed to.
  if (request.method === "GET") {
    return seeOther(env, "confirm", url.searchParams.get("token"));
  }

  const body = await readBody(request);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!TOKEN_RE.test(token)) return json({ ok: false, error: "invalid_token" }, { status: 400 });

  // Conditional and atomic. `status = 'pending'` in the WHERE clause is what
  // enforces pending-only confirmation: as a read-then-write, an unsubscribe
  // landing between the two would be silently undone by the write.
  const updated = await env.DB.prepare(
    "UPDATE subscribers SET status = 'confirmed', confirmed_at = ?2 " +
      "WHERE confirm_token = ?1 AND status = 'pending'"
  )
    .bind(token, new Date().toISOString())
    .run();

  if (updated.meta && updated.meta.changes > 0) return json({ ok: true, status: "confirmed" });

  // Nothing moved. Work out why — reading only, so this cannot resurrect a row.
  const row = await env.DB.prepare("SELECT status FROM subscribers WHERE confirm_token = ?1")
    .bind(token)
    .first();

  if (!row) return json({ ok: false, error: "unknown_token" }, { status: 404 });

  // A second click on the same link reads as "already done" rather than an
  // error: the token is not consumed on success.
  if (row.status === "confirmed") return json({ ok: true, status: "already_confirmed" });

  // Unsubscribing rotates confirm_token, so an unsubscribed row should never
  // be reachable by a live confirm link. Belt and braces for the case where it
  // is — this is the "old confirm cannot re-subscribe" rule.
  return json({ ok: false, error: "unsubscribed" }, { status: 409 });
}

async function handleUnsubscribe(request, url, env) {
  const queryToken = (url.searchParams.get("token") || "").trim();

  if (request.method === "GET") {
    return seeOther(env, "unsubscribe", queryToken);
  }

  const body = await readBody(request);
  const bodyToken = typeof body.token === "string" ? body.token.trim() : "";

  // Two POSTers, told apart by where the token is. Mail clients doing RFC 8058
  // one-click put it in the query string (their body is
  // `List-Unsubscribe=One-Click`); the status page sends JSON. Only the page
  // gets a meaningful status back — mail clients retry on non-2xx, so an
  // unknown token must still answer 200 there rather than trigger a retry loop.
  //
  // ⚠️ A token in the query is what makes a request one-click — never the
  // mere absence of one in the body. Inferring it the other way hands that
  // retry-proof `{ok:true}` to a status-page POST whose body was empty or
  // unparseable, reporting success for an unsubscribe that never happened and
  // hiding the client bug that caused it. With no token anywhere there is no
  // mail client to protect, so that answers 400 like any other bad request.
  const oneClick = Boolean(queryToken) && !bodyToken;
  const token = bodyToken || queryToken;

  if (!TOKEN_RE.test(token)) {
    return oneClick ? json({ ok: true }) : json({ ok: false, error: "invalid_token" }, { status: 400 });
  }

  // Idempotent: an already-unsubscribed row matches and is rewritten to the
  // same state, so a second click is a success rather than a dead link.
  //
  // ⚠️ confirm_token is rotated here; unsubscribe_token deliberately is NOT.
  // Rotating the confirm token kills any outstanding confirmation mail, which
  // is the capability to *add* this address back. The unsubscribe token is the
  // capability to *remove*, it is already sitting in every message ever sent,
  // and rotating it would break both idempotency and the List-Unsubscribe
  // header in mail that has already gone out.
  const result = await env.DB.prepare(
    "UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ?2, confirm_token = ?3 " +
      "WHERE unsubscribe_token = ?1"
  )
    .bind(token, new Date().toISOString(), newToken())
    .run();

  const matched = result.meta && result.meta.changes > 0;

  if (oneClick) return json({ ok: true });

  return matched
    ? json({ ok: true, status: "unsubscribed" })
    : json({ ok: false, error: "unknown_token" }, { status: 404 });
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
    // Two different URLs on purpose. The one a person clicks goes to the
    // status page, which asks before doing anything. The one in the header is
    // POSTed by Gmail/Yahoo themselves with no human present, so it has to
    // stay a machine endpoint on the API — RFC 8058 requires that POST to act.
    const unsubUrl = actionUrl(env, "unsubscribe", row.unsubscribe_token);
    const oneClickUrl = `${apiBase(env)}/api/unsubscribe?token=${row.unsubscribe_token}`;
    return {
      to: row.email,
      subject,
      html: incidentHtml(env, { action, title, issueUrl, unsubUrl }),
      text: incidentText(env, { action, title, issueUrl, unsubUrl }),
      headers: {
        "List-Unsubscribe": `<${oneClickUrl}>`,
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
      `updates at this address. Open the confirmation page, then confirm there:</p>` +
      `<p style="margin:0 0 24px"><a href="${confirmUrl}" ` +
      `style="background:#0b7285;color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;display:inline-block">` +
      `Continue to confirmation</a></p>` +
      `<p style="margin:0 0 8px;color:#666;font-size:13px">Or paste this link into your browser:<br>` +
      `<span style="word-break:break-all">${confirmUrl}</span></p>` +
      `<p style="margin:20px 0 0;color:#666;font-size:13px">If you did not request this, ignore this email — ` +
      `no subscription is created unless you open the page and press Confirm subscription.</p>`
  );
}

function confirmText(env, confirmUrl) {
  return (
    `Confirm your ${brand(env)} subscription\n\n` +
    `Someone - hopefully you - asked to receive status updates at this address.\n` +
    `Open this link, then confirm on the page:\n\n${confirmUrl}\n\n` +
    `If you did not request this, ignore this email. No subscription is created\n` +
    `unless you open the page and press Confirm subscription.\n`
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

/**
 * The user-visible URL for an action, on the status site.
 *
 * The token goes in the fragment, not the query string, and that is the whole
 * point: a fragment is never transmitted to a server, so it stays out of
 * GitHub Pages' logs, out of any CDN in front of them, and out of the Referer
 * of every asset the page loads. The page scrubs it from the address bar as
 * soon as it has read it, so it does not reach history or a bookmark either.
 */
function actionUrl(env, action, token) {
  return `${statusSite(env)}/#subscription=${action}&token=${token}`;
}

/**
 * Send a link click to the status page without touching the database.
 *
 * 303 rather than 302 so the redirect is unambiguously a GET. A malformed or
 * missing token still redirects — the page renders "link not recognised"
 * without a network call, which keeps this endpoint from being a token oracle.
 */
function seeOther(env, action, token) {
  const clean = (token || "").trim();
  const target = TOKEN_RE.test(clean)
    ? actionUrl(env, action, clean)
    : `${statusSite(env)}/#subscription=invalid`;

  return new Response(null, {
    status: 303,
    headers: {
      Location: target,
      // The token is in this Location header. Keep it out of shared caches,
      // out of the Referer of whatever the status page loads next, and out of
      // search indexes.
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
