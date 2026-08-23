/**
 * Daily send budget.
 *
 * The ceiling exists because Gmail's per-user limit locks the *account* for
 * ~24h when crossed, and that account is info@emoexai.com. These tests pin
 * the two properties that make it worth having: it fails closed, and a
 * flooded subscribe form cannot starve outage notices.
 *
 * Run: npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { withDailyBudget } from "../src/mailer.js";

/** Minimal D1 stand-in for the two statements reserve() issues. */
function fakeDb({ failing = false } = {}) {
  const rows = new Map();
  const prepare = (sql) => ({
    bind(...args) {
      return {
        async first() {
          if (failing) throw new Error("D1 unavailable");
          const [key, windowStart, delta] = args;
          const row = rows.get(key);
          const count = row && row.windowStart === windowStart ? row.count + delta : delta;
          rows.set(key, { windowStart, count });
          return { count };
        },
        async run() {
          if (failing) throw new Error("D1 unavailable");
          const [key, delta, windowStart] = args;
          const row = rows.get(key);
          if (row && row.windowStart === windowStart) row.count -= delta;
          return { success: true };
        },
      };
    },
  });
  return { prepare, _rows: rows };
}

/** Records what actually reached the provider. */
function spyMailer() {
  const seen = [];
  return {
    name: "spy",
    configured: true,
    seen,
    async send(mail) {
      seen.push(mail);
      return { ok: true };
    },
    async sendMany(mails) {
      seen.push(...mails);
      return { sent: mails.length, failures: [] };
    },
  };
}

const broadcast = (n) =>
  Array.from({ length: n }, (_, i) => ({ to: `s${i}@example.test`, kind: "broadcast" }));

const confirmation = { to: "new@example.test", kind: "transactional" };

test("passes straight through when no cap is configured", async () => {
  const spy = spyMailer();
  const mailer = withDailyBudget(spy, {});
  assert.equal(mailer, spy);
});

test("never wraps an unconfigured provider", async () => {
  const nullish = { name: "none", configured: false, async send() {}, async sendMany() {} };
  assert.equal(withDailyBudget(nullish, { MAIL_DAILY_CAP: "800" }), nullish);
});

test("sends everything while under the cap", async () => {
  const spy = spyMailer();
  const mailer = withDailyBudget(spy, { MAIL_DAILY_CAP: "800", DB: fakeDb() });

  const result = await mailer.sendMany(broadcast(100));
  assert.equal(result.sent, 100);
  assert.equal(result.failures.length, 0);
});

test("sends a partial batch rather than nothing when the cap is mid-batch", async () => {
  const spy = spyMailer();
  const mailer = withDailyBudget(spy, { MAIL_DAILY_CAP: "150", DB: fakeDb() });

  await mailer.sendMany(broadcast(100));
  const second = await mailer.sendMany(broadcast(100));

  // 50 of the second batch fit; the rest are reported failed, not queued.
  assert.equal(second.sent, 50);
  assert.equal(second.failures.length, 50);
  assert.equal(second.failures[0].error, "daily_cap_reached");
  assert.equal(spy.seen.length, 150);
});

test("a flooded subscribe form cannot starve outage notices", async () => {
  const spy = spyMailer();
  const env = { MAIL_DAILY_CAP: "800", MAIL_DAILY_CAP_SUBSCRIBE: "10", DB: fakeDb() };
  const mailer = withDailyBudget(spy, env);

  // Burn the confirmation sub-cap.
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await mailer.send(confirmation)).ok, true);
  }
  const refused = await mailer.send(confirmation);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "daily_cap_reached");

  // ...and the incident notice still goes out. This is the whole point.
  const notice = await mailer.sendMany(broadcast(100));
  assert.equal(notice.sent, 100);
  assert.equal(notice.failures.length, 0);
});

test("refused confirmations do not silently consume the total budget", async () => {
  const db = fakeDb();
  const mailer = withDailyBudget(spyMailer(), {
    MAIL_DAILY_CAP: "800",
    MAIL_DAILY_CAP_SUBSCRIBE: "2",
    DB: db,
  });

  await mailer.send(confirmation);
  await mailer.send(confirmation);
  await mailer.send(confirmation); // refused by the sub-cap

  // Two sent, so two spent — the refusal is handed back, not left on the tab.
  assert.equal(db._rows.get("mail:daily").count, 2);
});

test("fails closed when the budget cannot be read", async () => {
  const spy = spyMailer();
  const mailer = withDailyBudget(spy, { MAIL_DAILY_CAP: "800", DB: fakeDb({ failing: true }) });

  const result = await mailer.sendMany(broadcast(10));
  assert.equal(result.sent, 0);
  assert.equal(result.failures.length, 10);
  assert.equal(spy.seen.length, 0, "nothing may reach Gmail without proven budget");
});
