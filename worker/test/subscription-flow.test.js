/**
 * The subscription state machine, the redirects, and the links in the mail.
 *
 * The rules these pin down, in the order they matter:
 *
 *   - **Confirm is pending-only, in one conditional statement.** As a
 *     read-then-write an unsubscribe landing between the two would be silently
 *     undone.
 *   - **Unsubscribe rotates confirm_token.** Without that, the confirmation
 *     link still sitting in someone's inbox is a live capability to put their
 *     address back on the list after they asked to be off it.
 *   - **Unsubscribe does NOT rotate unsubscribe_token.** That token is already
 *     in every message ever sent, and rotating it would break both idempotency
 *     and the List-Unsubscribe header in mail that has gone out.
 *   - **GET mutates nothing.** Mail scanners, link previews and prefetchers
 *     issue GETs with no human present.
 *   - **Nothing user-visible is served from the API.** Mail links point at the
 *     status page, with the token in the fragment.
 *
 * Run: npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker from "../src/index.js";

const STATUS_SITE = "https://status.emoexai.com";
const API = "https://status-api.emoexai.com";
const TOKEN_RE = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

/** In-memory stand-in for the D1 statements this worker issues. */
function fakeDb() {
  const subscribers = new Map(); // email -> row
  const counters = new Map();
  const notifications = new Map();
  let nextId = 1;
  let loseNextResubscribe = false;

  const rowByToken = (field, token) =>
    [...subscribers.values()].find((row) => row[field] === token);

  const prepare = (sql) => ({
    // handleNotify calls .all() straight off prepare(), with no bind().
    async all() {
      if (sql.startsWith("SELECT email, unsubscribe_token")) {
        return {
          results: [...subscribers.values()]
            .filter((row) => row.status === "confirmed")
            .map((row) => ({ email: row.email, unsubscribe_token: row.unsubscribe_token })),
        };
      }
      throw new Error(`unexpected all(): ${sql}`);
    },
    bind(...args) {
      return {
        async first() {
          if (sql.includes("INSERT INTO rate_limits")) {
            const [key, windowStart] = args;
            const delta = args[2] ?? 1;
            const prev = counters.get(key);
            const count = prev && prev.windowStart === windowStart ? prev.count + delta : delta;
            counters.set(key, { windowStart, count });
            return { count };
          }
          if (sql.startsWith("SELECT id, status, confirm_token")) {
            return subscribers.get(args[0]) || null;
          }
          if (sql.startsWith("SELECT status FROM subscribers WHERE confirm_token")) {
            const row = rowByToken("confirm_token", args[0]);
            return row ? { status: row.status } : null;
          }
          throw new Error(`unexpected first(): ${sql}`);
        },

        async all() {
          if (sql.startsWith("SELECT email, unsubscribe_token")) {
            return {
              results: [...subscribers.values()]
                .filter((row) => row.status === "confirmed")
                .map((row) => ({ email: row.email, unsubscribe_token: row.unsubscribe_token })),
            };
          }
          throw new Error(`unexpected all(): ${sql}`);
        },

        async run() {
          if (sql.startsWith("INSERT INTO subscribers")) {
            const [email, confirm_token, unsubscribe_token, created_at] = args;
            subscribers.set(email, {
              id: nextId++,
              email,
              status: "pending",
              confirm_token,
              unsubscribe_token,
              created_at,
              confirmed_at: null,
              unsubscribed_at: null,
              last_sent_at: 0,
            });
            return { meta: { changes: 1 } };
          }

          // Resubscribe is a conditional claim. Modelling the SQL guard here
          // matters: otherwise tests would stay green if production reverted
          // to an unconditional read-then-write.
          if (sql.includes("SET status = 'pending'")) {
            assert.match(
              sql,
              /WHERE id = \?1 AND status = 'unsubscribed'/,
              "resubscribe must be conditional on the row still being unsubscribed"
            );
            const [id, confirmToken] = args;
            const row = [...subscribers.values()].find((r) => r.id === id);
            if (loseNextResubscribe || !row || row.status !== "unsubscribed") {
              loseNextResubscribe = false;
              return { meta: { changes: 0 } };
            }
            Object.assign(row, {
              status: "pending",
              unsubscribed_at: null,
              confirm_token: confirmToken,
            });
            return { meta: { changes: 1 } };
          }

          // The conditional confirm. The status guard is the point of the test.
          if (sql.includes("SET status = 'confirmed'")) {
            assert.match(
              sql,
              /AND status = 'pending'/,
              "confirm must enforce the pending-only transition in SQL"
            );
            const [token, confirmedAt] = args;
            const row = rowByToken("confirm_token", token);
            if (!row || row.status !== "pending") return { meta: { changes: 0 } };
            Object.assign(row, { status: "confirmed", confirmed_at: confirmedAt });
            return { meta: { changes: 1 } };
          }

          if (sql.includes("SET status = 'unsubscribed'")) {
            const [token, unsubscribedAt, newConfirmToken] = args;
            const row = rowByToken("unsubscribe_token", token);
            if (!row) return { meta: { changes: 0 } };
            Object.assign(row, {
              status: "unsubscribed",
              unsubscribed_at: unsubscribedAt,
              confirm_token: newConfirmToken,
            });
            return { meta: { changes: 1 } };
          }

          if (sql.includes("SET last_sent_at")) {
            subscribers.get(args[0]).last_sent_at = args[1];
            return { meta: { changes: 1 } };
          }

          if (sql.includes("UPDATE rate_limits")) {
            const [key, delta, windowStart] = args;
            const row = counters.get(key);
            if (row && row.windowStart === windowStart) row.count -= delta;
            return { meta: { changes: 1 } };
          }

          if (sql.startsWith("INSERT OR IGNORE INTO notifications")) {
            if (notifications.has(args[0])) return { meta: { changes: 0 } };
            notifications.set(args[0], { recipients: 0 });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE notifications")) {
            notifications.get(args[0]).recipients = args[1];
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("DELETE FROM notifications")) {
            notifications.delete(args[0]);
            return { meta: { changes: 1 } };
          }

          throw new Error(`unexpected run(): ${sql}`);
        },
      };
    },
  });

  return {
    prepare,
    subscribers,
    notifications,
    only: () => [...subscribers.values()][0],
    loseNextResubscribe() {
      loseNextResubscribe = true;
    },
  };
}

/** A DB that fails the test if it is touched at all. */
const forbiddenDb = new Proxy(
  {},
  {
    get() {
      throw new Error("this path must not touch the database");
    },
  }
);

const envWith = (db) => ({
  BRAND_NAME: "EmoEx Status",
  STATUS_URL: STATUS_SITE,
  API_BASE_URL: API,
  ALLOWED_ORIGINS: STATUS_SITE,
  NOTIFY_SECRET: "test-secret",
  MAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_test",
  MAIL_FROM: "EmoEx Status <info@emoexai.com>",
  MAIL_DAILY_CAP: "800",
  MAIL_DAILY_CAP_SUBSCRIBE: "150",
  DB: db,
});

/**
 * Capture what the provider was asked to send, and answer 200.
 *
 * Flattened because the two paths use different Resend endpoints: a single
 * confirmation POSTs one object, a fan-out POSTs an array to the batch
 * endpoint. Tests care about the messages, not which endpoint carried them.
 */
function captureMail(t, responder = async () => new Response("{}", { status: 200 })) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    sent.push(...(Array.isArray(body) ? body : [body]));
    return responder(_url, options);
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return sent;
}

const post = (path, body, headers) =>
  new Request(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const get = (path, headers) => new Request(`${API}${path}`, { method: "GET", headers });

const subscribe = (db, email = "reader@example.test") =>
  worker.fetch(post("/api/subscribe", { email }), envWith(db));

const confirm = (db, token) => worker.fetch(post("/api/confirm", { token }), envWith(db));

const unsubscribe = (db, token) => worker.fetch(post("/api/unsubscribe", { token }), envWith(db));

/** Subscribe, then hand back the row's tokens. */
async function subscribed(t, db) {
  captureMail(t);
  await subscribe(db);
  const row = db.only();
  return { confirmToken: row.confirm_token, unsubscribeToken: row.unsubscribe_token };
}

/* ------------------------------------------------------------------ */
/* D1 state                                                            */
/* ------------------------------------------------------------------ */

test("subscribing stores a pending row with a 64-hex confirm token", async (t) => {
  const db = fakeDb();
  captureMail(t);

  const response = await subscribe(db);

  assert.equal(response.status, 200);
  const row = db.only();
  assert.equal(row.status, "pending");
  assert.match(row.confirm_token, TOKEN_RE);
  assert.match(row.unsubscribe_token, TOKEN_RE);
});

test("confirming a pending row moves it to confirmed", async (t) => {
  const db = fakeDb();
  const { confirmToken } = await subscribed(t, db);

  const response = await confirm(db, confirmToken);

  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "confirmed");
  assert.equal(db.only().status, "confirmed");
});

test("confirming twice reads as already done rather than an error", async (t) => {
  const db = fakeDb();
  const { confirmToken } = await subscribed(t, db);
  await confirm(db, confirmToken);

  const again = await confirm(db, confirmToken);

  assert.equal(again.status, 200);
  assert.equal((await again.json()).status, "already_confirmed");
  assert.equal(db.only().status, "confirmed");
});

test("an unknown confirm token is a 404 and creates nothing", async (t) => {
  const db = fakeDb();
  await subscribed(t, db);

  const response = await confirm(db, "b".repeat(64));

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "unknown_token");
  assert.equal(db.subscribers.size, 1);
});

test("a malformed confirm token is rejected before the database", async () => {
  const response = await worker.fetch(
    post("/api/confirm", { token: "not-a-token" }),
    envWith(forbiddenDb)
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_token");
});

test("unsubscribing marks the row and rotates the confirm token", async (t) => {
  const db = fakeDb();
  const { confirmToken, unsubscribeToken } = await subscribed(t, db);

  const response = await unsubscribe(db, unsubscribeToken);

  assert.equal(response.status, 200);
  const row = db.only();
  assert.equal(row.status, "unsubscribed");
  assert.notEqual(row.confirm_token, confirmToken, "the old confirmation link must be dead");
  assert.match(row.confirm_token, TOKEN_RE);
});

test("unsubscribing does NOT rotate the unsubscribe token", async (t) => {
  // It is already in every message ever sent. Rotating it would break the
  // List-Unsubscribe header in mail that has gone out, and idempotency below.
  const db = fakeDb();
  const { unsubscribeToken } = await subscribed(t, db);

  await unsubscribe(db, unsubscribeToken);

  assert.equal(db.only().unsubscribe_token, unsubscribeToken);
});

test("unsubscribing twice is idempotent", async (t) => {
  const db = fakeDb();
  const { unsubscribeToken } = await subscribed(t, db);

  await unsubscribe(db, unsubscribeToken);
  const again = await unsubscribe(db, unsubscribeToken);

  assert.equal(again.status, 200);
  assert.equal((await again.json()).status, "unsubscribed");
  assert.equal(db.only().status, "unsubscribed");
});

test("an old confirm link cannot put an unsubscribed address back on the list", async (t) => {
  // The rule the rotation exists for. The confirmation mail is still sitting
  // in the inbox after the unsubscribe; clicking it must not resurrect them.
  const db = fakeDb();
  const { confirmToken, unsubscribeToken } = await subscribed(t, db);
  await confirm(db, confirmToken);
  await unsubscribe(db, unsubscribeToken);

  const replay = await confirm(db, confirmToken);

  assert.equal(replay.status, 404, "the token was rotated, so it is simply unknown now");
  assert.equal(db.only().status, "unsubscribed", "still off the list");
});

test("confirm is pending-only even if a token for an unsubscribed row survives", async (t) => {
  // Belt and braces for the rotation above: point a live token at an
  // unsubscribed row directly and check the SQL guard, not the rotation.
  const db = fakeDb();
  const { unsubscribeToken } = await subscribed(t, db);
  await unsubscribe(db, unsubscribeToken);

  const survivor = db.only().confirm_token;
  const response = await confirm(db, survivor);

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "unsubscribed");
  assert.equal(db.only().status, "unsubscribed", "the conditional UPDATE must not have fired");
});

test("resubscribing issues a fresh token and kills the previous one", async (t) => {
  const db = fakeDb();
  const { confirmToken, unsubscribeToken } = await subscribed(t, db);
  await unsubscribe(db, unsubscribeToken);

  // The first confirmation stamped last_sent_at, and a resubscribe inside the
  // 5-minute cooldown is a deliberate no-op. Wind it back rather than sleep.
  db.only().last_sent_at = 0;

  captureMail(t);
  await subscribe(db);
  const row = db.only();

  assert.equal(row.status, "pending");
  assert.notEqual(row.confirm_token, confirmToken);
  assert.equal((await confirm(db, confirmToken)).status, 404, "the first link stays dead");
  assert.equal((await confirm(db, row.confirm_token)).status, 200);
});

test("a failed pending resend preserves the confirmation link already delivered", async (t) => {
  const db = fakeDb();
  let fail = false;
  captureMail(t, async () =>
    fail ? new Response("provider unavailable", { status: 503 }) : new Response("{}", { status: 200 })
  );

  await subscribe(db);
  const originalToken = db.only().confirm_token;
  db.only().last_sent_at = 0;
  fail = true;

  const response = await subscribe(db);

  assert.equal(response.status, 502);
  assert.equal(db.only().status, "pending");
  assert.equal(
    db.only().confirm_token,
    originalToken,
    "a failed replacement send must not invalidate the link the subscriber already has"
  );
});

test("a pending resend writes no state, so a concurrent confirmation cannot be undone", async (t) => {
  const db = fakeDb();
  let confirmDuringSend = false;
  let confirmToken;
  captureMail(t, async () => {
    if (confirmDuringSend) await confirm(db, confirmToken);
    return new Response("{}", { status: 200 });
  });

  await subscribe(db);
  confirmToken = db.only().confirm_token;
  db.only().last_sent_at = 0;
  confirmDuringSend = true;

  await subscribe(db);

  assert.equal(db.only().status, "confirmed");
  assert.equal(db.only().confirm_token, confirmToken);
});

test("a resubscribe that loses the conditional claim sends no competing token", async (t) => {
  const db = fakeDb();
  const sent = captureMail(t);

  await subscribe(db);
  await unsubscribe(db, db.only().unsubscribe_token);
  db.only().last_sent_at = 0;
  const sentBeforeRace = sent.length;
  db.loseNextResubscribe();

  const response = await subscribe(db);

  assert.equal(response.status, 200, "the public response stays enumeration-safe");
  assert.equal(sent.length, sentBeforeRace, "only the winner of the state claim may send");
  assert.equal(db.only().status, "unsubscribed", "the fake models the losing snapshot");
});

/* ------------------------------------------------------------------ */
/* RFC 8058 one-click                                                  */
/* ------------------------------------------------------------------ */

test("one-click unsubscribe still works with the token in the query string", async (t) => {
  const db = fakeDb();
  const { unsubscribeToken } = await subscribed(t, db);

  const response = await worker.fetch(
    new Request(`${API}/api/unsubscribe?token=${unsubscribeToken}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    }),
    envWith(db)
  );

  assert.equal(response.status, 200);
  assert.equal(db.only().status, "unsubscribed");
});

test("one-click with an unknown token still answers 200", async () => {
  // Mail clients retry one-click on non-2xx. A 404 here would be a retry loop.
  const db = fakeDb();
  const response = await worker.fetch(
    new Request(`${API}/api/unsubscribe?token=${"c".repeat(64)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    }),
    envWith(db)
  );
  assert.equal(response.status, 200);
});

test("browser unsubscribe rejects a missing, empty, or malformed JSON token", async () => {
  const requests = [
    post("/api/unsubscribe", {}),
    post("/api/unsubscribe", { token: "" }),
    new Request(`${API}/api/unsubscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    }),
  ];

  for (const request of requests) {
    const response = await worker.fetch(request, envWith(forbiddenDb));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_token");
  }
});

/* ------------------------------------------------------------------ */
/* Redirects                                                           */
/* ------------------------------------------------------------------ */

const redirectCases = [
  ["confirm", `/api/confirm?token=${"d".repeat(64)}`, "d".repeat(64)],
  ["unsubscribe", `/api/unsubscribe?token=${"e".repeat(64)}`, "e".repeat(64)],
];

for (const [action, path, token] of redirectCases) {
  test(`GET /api/${action} redirects to the status page and touches nothing`, async () => {
    const response = await worker.fetch(get(path), envWith(forbiddenDb));

    assert.equal(response.status, 303, "303 so the follow-up is unambiguously a GET");
    assert.equal(
      response.headers.get("Location"),
      `${STATUS_SITE}/#subscription=${action}&token=${token}`
    );
  });
}

test("the redirect keeps the token out of caches, referrers and indexes", async () => {
  const response = await worker.fetch(
    get(`/api/confirm?token=${"d".repeat(64)}`),
    envWith(forbiddenDb)
  );

  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.match(response.headers.get("X-Robots-Tag"), /noindex/);
});

test("a malformed token in a GET redirects to the invalid card, not a token echo", async () => {
  const response = await worker.fetch(get("/api/confirm?token=nope"), envWith(forbiddenDb));

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), `${STATUS_SITE}/#subscription=invalid`);
});

test("a GET with no token at all still redirects rather than erroring", async () => {
  const response = await worker.fetch(get("/api/unsubscribe"), envWith(forbiddenDb));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), `${STATUS_SITE}/#subscription=invalid`);
});

/* ------------------------------------------------------------------ */
/* No user-visible HTML from the API                                   */
/* ------------------------------------------------------------------ */

test("the API serves no HTML on any confirm/unsubscribe path", async () => {
  const responses = await Promise.all([
    worker.fetch(get(`/api/confirm?token=${"d".repeat(64)}`), envWith(forbiddenDb)),
    worker.fetch(get(`/api/unsubscribe?token=${"e".repeat(64)}`), envWith(forbiddenDb)),
    worker.fetch(get("/api/confirm?token=nope"), envWith(forbiddenDb)),
  ]);

  for (const response of responses) {
    const type = response.headers.get("content-type") || "";
    assert.doesNotMatch(type, /text\/html/, "user-visible pages belong on the status site");
  }
});

/* ------------------------------------------------------------------ */
/* Links in the mail                                                   */
/* ------------------------------------------------------------------ */

test("the confirmation email links to the status page, not the API", async (t) => {
  const db = fakeDb();
  const sent = captureMail(t);
  await subscribe(db);

  const [mail] = sent;
  const expected = `${STATUS_SITE}/#subscription=confirm&token=${db.only().confirm_token}`;

  assert.ok(mail.html.includes(expected), "the HTML button must point at the status page");
  assert.ok(mail.text.includes(expected), "so must the plain-text alternative");
  assert.match(mail.html, /Continue to confirmation/);
  assert.match(mail.text, /then confirm on the page/i);
  assert.doesNotMatch(
    mail.html,
    /subscription is created until the link above is clicked/i,
    "opening the page alone no longer mutates the subscription"
  );
  assert.ok(
    !mail.html.includes(`${API}/api/confirm`),
    "no confirmation link may point at the API any more"
  );
});

test("incident mail sends humans to the status page and machines to the API", async (t) => {
  const db = fakeDb();
  const { confirmToken } = await subscribed(t, db);
  await confirm(db, confirmToken);
  const token = db.only().unsubscribe_token;

  const sent = captureMail(t);
  const response = await worker.fetch(
    post(
      "/api/notify",
      { action: "opened", number: 7, title: "API is down", url: "https://example.test/7" },
      { authorization: "Bearer test-secret" }
    ),
    envWith(db)
  );
  assert.equal(response.status, 200);

  const [mail] = sent;
  const humanUrl = `${STATUS_SITE}/#subscription=unsubscribe&token=${token}`;
  const machineUrl = `${API}/api/unsubscribe?token=${token}`;

  assert.ok(mail.html.includes(humanUrl), "the link a person clicks goes to the status page");
  assert.ok(mail.text.includes(humanUrl));
  assert.equal(
    mail.headers["List-Unsubscribe"],
    `<${machineUrl}>`,
    "RFC 8058 one-click is POSTed by the mail client, so it stays a machine endpoint"
  );
  assert.equal(mail.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

/* ------------------------------------------------------------------ */
/* Documented claims that the code has to keep true                    */
/* ------------------------------------------------------------------ */

test("every route the README calls browser-facing actually exists", async () => {
  // Two rounds of review caught the README claiming things the code does not
  // do — that /api/subscribe was the only route a browser waits on, and that
  // an old worker redirects. Doc drift here is not cosmetic: the deploy-order
  // section is the one thing in this repo that fails silently if it is wrong.
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

  const browserRoutes = ["/api/subscribe", "/api/confirm", "/api/unsubscribe"];
  for (const route of browserRoutes) {
    assert.ok(readme.includes(route), `${route} is missing from the README`);
  }

  assert.doesNotMatch(
    readme,
    /`POST \/api\/subscribe` is the only route a browser waits on/,
    "the page waits on confirm and unsubscribe too"
  );
  assert.doesNotMatch(
    readme,
    /the old worker[\s\S]{0,80}redirect/i,
    "the redirects ship with the new worker; the old one cannot have them"
  );
});

test("the routes the README documents as browser-facing all answer a JSON POST", async (t) => {
  // Cheap guard that the table above is not describing a route that 404s.
  const db = fakeDb();
  const { confirmToken, unsubscribeToken } = await subscribed(t, db);

  assert.equal((await confirm(db, confirmToken)).status, 200);
  assert.equal((await unsubscribe(db, unsubscribeToken)).status, 200);
});

/* ------------------------------------------------------------------ */
/* CORS on the new routes                                              */
/* ------------------------------------------------------------------ */

for (const path of ["/api/confirm", "/api/unsubscribe"]) {
  test(`preflight admits a JSON POST to ${path}`, async () => {
    const response = await worker.fetch(
      new Request(`${API}${path}`, {
        method: "OPTIONS",
        headers: {
          Origin: STATUS_SITE,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      }),
      envWith(forbiddenDb)
    );

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), STATUS_SITE);
    assert.match(response.headers.get("Access-Control-Allow-Headers"), /content-type/i);
  });
}

test("the confirm response carries CORS, so the page can read the outcome", async (t) => {
  const db = fakeDb();
  const { confirmToken } = await subscribed(t, db);

  const response = await worker.fetch(
    post("/api/confirm", { token: confirmToken }, { Origin: STATUS_SITE }),
    envWith(db)
  );

  assert.equal(response.headers.get("Access-Control-Allow-Origin"), STATUS_SITE);
});

test("an origin that is not the status page gets no allow header", async (t) => {
  const db = fakeDb();
  const { confirmToken } = await subscribed(t, db);

  const response = await worker.fetch(
    post("/api/confirm", { token: confirmToken }, { Origin: "https://evil.example" }),
    envWith(db)
  );

  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});
