/**
 * Smoke tests for the unconfigured-provider state we actually ship.
 *
 * Every case here is deliberately chosen to avoid touching env.DB: the
 * no-provider guards all sit in front of the database, and proving that is
 * the point — an unconfigured worker must not write pending rows it can
 * never confirm. Tests that exercise the D1 paths need `wrangler dev`
 * against a local database; see README.md.
 *
 * Run: npm test   (node's built-in runner, no dependencies)
 */

import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

const ENV = {
  BRAND_NAME: "EmoEx Status",
  STATUS_URL: "https://status.emoexai.com",
  API_BASE_URL: "https://status-api.emoexai.com",
  ALLOWED_ORIGINS: "https://status.emoexai.com",
  NOTIFY_SECRET: "test-secret",
  // MAIL_PROVIDER intentionally unset — this is the shipped default.
  DB: new Proxy(
    {},
    {
      get() {
        throw new Error("database must not be touched while mail is unconfigured");
      },
    }
  ),
};

const post = (path, { body, headers } = {}) =>
  new Request(`https://status-api.emoexai.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });

const get = (path, headers) =>
  new Request(`https://status-api.emoexai.com${path}`, { method: "GET", headers });

test("health reports subscribe_enabled:false with no provider", async () => {
  const response = await worker.fetch(get("/api/health"), ENV);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.subscribe_enabled, false);
});

test("health flips to true once a provider is configured", async () => {
  const env = { ...ENV, MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x", MAIL_FROM: "a@b.co" };
  const body = await (await worker.fetch(get("/api/health"), env)).json();
  assert.equal(body.subscribe_enabled, true);
});

test("subscribe refuses without a provider and never touches the database", async () => {
  const response = await worker.fetch(post("/api/subscribe", { body: { email: "a@b.co" } }), ENV);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "subscriptions_closed");
});

test("notify rejects a missing or wrong bearer token", async () => {
  assert.equal((await worker.fetch(post("/api/notify"), ENV)).status, 401);

  const wrong = await worker.fetch(
    post("/api/notify", { headers: { authorization: "Bearer nope" } }),
    ENV
  );
  assert.equal(wrong.status, 401);
});

test("notify accepts the right token but skips while unconfigured", async () => {
  const response = await worker.fetch(
    post("/api/notify", {
      headers: { authorization: `Bearer ${ENV.NOTIFY_SECRET}` },
      body: { action: "opened", number: 7, title: "API is down", url: "https://example.test/7" },
    }),
    ENV
  );
  assert.equal(response.status, 200, "must not turn the notify workflow permanently red");
  const body = await response.json();
  assert.deepEqual(
    { ok: body.ok, skipped: body.skipped, reason: body.reason, sent: body.sent },
    { ok: true, skipped: true, reason: "mail_not_configured", sent: 0 }
  );
});

test("notify validates the payload before doing any work", async () => {
  const response = await worker.fetch(
    post("/api/notify", {
      headers: { authorization: `Bearer ${ENV.NOTIFY_SECRET}` },
      body: { action: "opened", title: "" },
    }),
    ENV
  );
  assert.equal(response.status, 400);
});

test("CORS echoes only allowed origins", async () => {
  const allowed = await worker.fetch(
    get("/api/health", { Origin: "https://status.emoexai.com" }),
    ENV
  );
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://status.emoexai.com");

  const denied = await worker.fetch(get("/api/health", { Origin: "https://evil.example" }), ENV);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
});

test("preflight is answered", async () => {
  const response = await worker.fetch(
    new Request("https://status-api.emoexai.com/api/subscribe", {
      method: "OPTIONS",
      headers: { Origin: "https://status.emoexai.com" },
    }),
    ENV
  );
  assert.equal(response.status, 204);
  assert.match(response.headers.get("Access-Control-Allow-Methods"), /POST/);
});

test("unknown routes 404", async () => {
  assert.equal((await worker.fetch(get("/api/nope"), ENV)).status, 404);
});
