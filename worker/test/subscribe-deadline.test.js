/**
 * The status page's subscribe deadlines.
 *
 * Regression cover for the bug where a valid address reported "Could not
 * reach the subscription service". The page gave every request one 8s
 * AbortController deadline, but POST /api/subscribe waits on the worker
 * completing a whole SMTP conversation with Gmail. A healthy send can outlive
 * that deadline, at which point `fetch` rejects with an AbortError and the
 * only rejection branch blames the network — for a subscription that may
 * still succeed.
 *
 * Measured once in production on 2026-08-30: a successful subscribe answered
 * 200 in 7.5s, i.e. inside the old 8s deadline by under half a second. One
 * sample, so it does not bound the slow end; it does show the margin was thin
 * enough for ordinary variation to cross.
 *
 * Two defects, and both are visible from here:
 *   1. One deadline served two calls that wait on completely different work.
 *   2. Giving up was reported as the service being unreachable, which is a
 *      guess — and the wrong one whenever the send was merely slow.
 *
 * ⚠️ These tests exercise the script injected by the `js:` block of
 * ../../.upptimerc.yml, not the worker. It lives here because this is the
 * repo's only test runner, and untested inline page JS is how the bug shipped.
 *
 * Run: npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  pageScript,
  loadPage,
  hangs,
  settle,
  pageWithSubscribeCard,
} from "../test-support/page-harness.js";

/* ------------------------------------------------------------------ */
/* The deadlines                                                       */
/* ------------------------------------------------------------------ */

/**
 * The floor the README promises. Without a concrete number the suite only
 * pins "longer than health" and "survives 8s", which 8001ms would satisfy —
 * and a real send has been measured at 7.5s, so 8001ms is demonstrably about
 * half a second of headroom over one observed success.
 */
const MIN_SUBSCRIBE_DEADLINE_MS = 30_000;

test(`subscribe waits at least ${MIN_SUBSCRIBE_DEADLINE_MS}ms`, async () => {
  const page = await pageWithSubscribeCard(hangs);
  page.subscribe.submit("reader@example.test");

  const [armed] = page.clock.armed();

  assert.ok(
    armed >= MIN_SUBSCRIBE_DEADLINE_MS,
    `the page gives up on a subscribe after ${armed}ms. A send measured in production took ` +
      `7500ms and the worker imposes no shorter ceiling of its own, so anything near that — ` +
      `and certainly anything below ${MIN_SUBSCRIBE_DEADLINE_MS}ms — risks reporting a working ` +
      `subscription as a failure. Raising this floor is fine; lowering it is the original bug.`
  );
});

test("health and subscribe ask for different deadlines, and health is the short one", async () => {
  const page = await pageWithSubscribeCard(hangs);

  // Nothing else is in flight once health has answered.
  page.subscribe.submit("reader@example.test");
  const [subscribeDeadline] = page.clock.armed();

  // Health left in flight on purpose, so its deadline is still armed.
  const healthPage = loadPage(hangs);
  const [healthDeadline] = healthPage.clock.armed();

  assert.ok(
    healthDeadline < subscribeDeadline,
    `health waits ${healthDeadline}ms and subscribe ${subscribeDeadline}ms — one deadline ` +
      `cannot serve both: health only decides whether the card renders, subscribe waits on a ` +
      `mail send.`
  );
});

test("a subscribe slower than the old 8s deadline is not abandoned", async () => {
  const page = await pageWithSubscribeCard(hangs);
  page.subscribe.submit("reader@example.test");

  // The exact window the bug lived in. A production send has been observed
  // finishing at 7.5s, so this is not a hypothetical slow path — it is where
  // a real successful subscribe has actually landed.
  page.clock.advance(8000);
  await settle();

  assert.equal(page.subscribe.message, "Sending…", "the page gave up while the request was still in flight");
});

test("when the page does give up, it does not claim the service is unreachable", async () => {
  const page = await pageWithSubscribeCard(hangs);
  page.subscribe.submit("reader@example.test");

  page.clock.advance(60_000); // past any deadline the page might reasonably use
  await settle();

  assert.doesNotMatch(
    page.subscribe.message,
    /could not reach/i,
    "an abort means we stopped waiting, not that the service is down — the send may still land"
  );
  assert.match(page.subscribe.message, /may still arrive/i);
});

test("a genuine transport failure is still reported as unreachable", async () => {
  // The message is correct here and must not be lost: this is a real network
  // failure, not us running out of patience.
  const page = await pageWithSubscribeCard(() => Promise.reject(new TypeError("Failed to fetch")));
  page.subscribe.submit("reader@example.test");
  await settle();

  assert.match(page.subscribe.message, /could not reach the subscription service/i);
});

test("the deadline is per request, not shared module state", async () => {
  // The regression shape itself: one module-level REQUEST_TIMEOUT_MS applied
  // to every call is what made the short deadline leak onto subscribe.
  assert.match(
    pageScript(),
    /function request\(path, options, timeoutMs\)/,
    "request() no longer takes a per-call deadline"
  );
  assert.doesNotMatch(pageScript(), /REQUEST_TIMEOUT_MS/, "the shared deadline is back");
});
