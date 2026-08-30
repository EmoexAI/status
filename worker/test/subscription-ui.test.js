/**
 * The confirm/unsubscribe landing on the status page.
 *
 * User-visible confirm and unsubscribe live on status.emoexai.com, not on the
 * API. A mail link carries `#subscription=<action>&token=<64hex>`, and three
 * properties make that safe rather than merely tidy:
 *
 *   1. **The token is in the fragment.** A fragment is never sent to a server,
 *      so it stays out of GitHub Pages' logs and out of the Referer of every
 *      asset the page loads.
 *   2. **The page scrubs it immediately.** Otherwise it lingers in the address
 *      bar, in session history, and in whatever the visitor copy-pastes.
 *   3. **Nothing happens without a click.** Gmail's scanner, chat link
 *      previews and browser prefetch all fetch URLs with no human present. An
 *      action that fires on load is a double opt-in that opted nobody in.
 *
 * Run: npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  loadPage,
  settle,
  hangs,
  jsonResponse,
  healthOk,
} from "../test-support/page-harness.js";

const TOKEN = "a".repeat(64);
const CONFIRM_HASH = `#subscription=confirm&token=${TOKEN}`;
const UNSUBSCRIBE_HASH = `#subscription=unsubscribe&token=${TOKEN}`;

/**
 * Load the page on a mail link, recording every request the script makes.
 * Health is answered so the ordinary subscribe card mounts too — the action
 * card must coexist with it.
 */
function landing(hash, respond = () => jsonResponse(200, { ok: true, status: "confirmed" })) {
  const calls = [];
  const page = loadPage(
    (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/api/health")) return healthOk();
      return respond(url, options);
    },
    { hash }
  );
  return { page, calls };
}

const actionCalls = (calls) => calls.filter((c) => !c.url.endsWith("/api/health"));

/* ------------------------------------------------------------------ */
/* Fragment handling                                                   */
/* ------------------------------------------------------------------ */

test("the token is scrubbed from the URL before any request goes out", async () => {
  const { page } = landing(CONFIRM_HASH);
  await settle();

  assert.equal(page.location.hash, "", "the token is still in the address bar");
  assert.deepEqual(
    page.replaceStateCalls,
    ["/"],
    "history.replaceState should have rewritten the URL without the fragment"
  );
});

test("the action waits for hydration but survives replacement of the generated main", async () => {
  const calls = [];
  const page = loadPage(
    (url) => {
      calls.push(url);
      return healthOk();
    },
    {
      hash: CONFIRM_HASH,
      readyState: "loading",
      containerPresent: false,
    }
  );

  assert.equal(page.location.hash, "", "the credential must be scrubbed immediately");
  assert.equal(page.action.present, false, "do not inject into a tree Svelte is still hydrating");

  page.finishLoad({ replaceContainer: true });
  await settle();

  assert.ok(page.action.present, "the action must mount into the hydrated container");
  assert.deepEqual(
    calls.filter((url) => /\/api\/(confirm|unsubscribe)$/.test(url)),
    [],
    "hydration must not perform the action"
  );
});

test("a later mail link in the same tab is consumed and replaces the action card", async () => {
  const { page, calls } = landing("");
  await settle();

  page.navigateHash(CONFIRM_HASH);
  await settle();
  assert.equal(page.location.hash, "");
  assert.match(page.action.heading, /confirm/i);

  page.navigateHash(UNSUBSCRIBE_HASH);
  await settle();
  assert.equal(page.location.hash, "");
  assert.match(page.action.heading, /unsubscribe/i);
  assert.equal(
    page.order.filter((id) => id === "maillist-action").length,
    1,
    "the newer mail link replaces rather than duplicates the action card"
  );
  assert.deepEqual(actionCalls(calls), [], "same-document navigation still waits for a click");
});

test("an unrelated fragment is left alone", async () => {
  const { page } = landing("#past-incidents");
  await settle();

  assert.equal(page.location.hash, "#past-incidents", "a plain anchor must not be scrubbed");
  assert.deepEqual(page.replaceStateCalls, []);
  assert.equal(page.action.present, false);
});

test("no fragment renders no action card", async () => {
  const { page, calls } = landing("");
  await settle();

  assert.equal(page.action.present, false);
  assert.deepEqual(actionCalls(calls), [], "nothing to act on, so nothing should be requested");
});

/* ------------------------------------------------------------------ */
/* Explicit click                                                      */
/* ------------------------------------------------------------------ */

test("landing on a confirm link performs nothing until the button is clicked", async () => {
  const { page, calls } = landing(CONFIRM_HASH);
  await settle();

  assert.ok(page.action.present, "the confirm card should have mounted");
  assert.match(page.action.heading, /confirm/i);
  assert.match(page.action.lead, /no status alerts are sent/i);
  assert.deepEqual(
    actionCalls(calls),
    [],
    "a mail scanner or prefetch opening this link must not confirm anybody"
  );

  page.action.click();
  await settle();

  const [sent] = actionCalls(calls);
  assert.ok(sent, "the click should have sent exactly one request");
  assert.match(sent.url, /\/api\/confirm$/);
  assert.equal(sent.options.method, "POST");
  assert.equal(JSON.parse(sent.options.body).token, TOKEN, "the token travels in the JSON body");
  assert.match(page.action.message, /confirmed/i);
});

test("landing on an unsubscribe link also waits for the click", async () => {
  const { page, calls } = landing(UNSUBSCRIBE_HASH, () =>
    jsonResponse(200, { ok: true, status: "unsubscribed" })
  );
  await settle();

  assert.ok(page.action.present);
  assert.match(page.action.heading, /unsubscribe/i);
  assert.deepEqual(actionCalls(calls), []);

  page.action.click();
  await settle();

  const [sent] = actionCalls(calls);
  assert.match(sent.url, /\/api\/unsubscribe$/);
  assert.equal(sent.options.method, "POST");
  assert.equal(JSON.parse(sent.options.body).token, TOKEN);
  assert.match(page.action.message, /unsubscribed/i);
});

test("the action card mounts first, above the subscribe card", async () => {
  const { page } = landing(CONFIRM_HASH);
  await settle();

  assert.deepEqual(
    page.order.filter(Boolean),
    ["maillist-action", "maillist"],
    "someone arriving from a mail link should not have to hunt for the result"
  );
});

/* ------------------------------------------------------------------ */
/* Bad links                                                           */
/* ------------------------------------------------------------------ */

test("a malformed token renders the invalid card and offers no button", async () => {
  const { page, calls } = landing("#subscription=confirm&token=nothex");
  await settle();

  assert.ok(page.action.present);
  assert.match(page.action.heading, /not recognised/i);
  assert.equal(page.action.button, null, "there is nothing to submit, so offer no button");
  assert.deepEqual(actionCalls(calls), []);
});

test("an unknown action renders the generic invalid card", async () => {
  const { page } = landing(`#subscription=delete-everything&token=${TOKEN}`);
  await settle();

  assert.match(page.action.heading, /not recognised/i);
  assert.equal(page.action.button, null);
  // Nothing is known about intent here, so it must not guess at advice.
  assert.doesNotMatch(page.action.lead, /subscribe again|unsubscribe link/i);
});

test("broken confirm and unsubscribe links give action-specific recovery", async () => {
  // Opposite advice, and getting it backwards is worst for the person trying
  // to leave: "subscribe again below" to someone who came to unsubscribe.
  const { page: badConfirm } = landing("#subscription=confirm&token=nothex");
  const { page: badUnsub } = landing("#subscription=unsubscribe&token=nothex");
  await settle();

  assert.match(badConfirm.action.heading, /confirmation link/i);
  assert.match(badConfirm.action.lead, /subscription form/i);

  assert.match(badUnsub.action.heading, /unsubscribe link/i);
  assert.match(badUnsub.action.lead, /use the unsubscribe link there/i);
  assert.doesNotMatch(
    badUnsub.action.lead,
    /subscribe again/i,
    "never tell someone trying to leave the list to join it again"
  );
});

test("the action card takes focus and names itself", async () => {
  const { page } = landing(CONFIRM_HASH);
  await settle();

  assert.deepEqual(
    page.focused,
    [page.action.element],
    "the card is injected after load, at the top of a page nobody asked for — " +
      "without focus a screen reader never mentions why the visitor arrived"
  );
  assert.equal(page.action.element.attributes.tabindex, "-1", "focusable, but not in the tab order");
  assert.equal(page.action.element.attributes["aria-label"], page.action.heading);
});

test("the invalid card still scrubs the fragment", async () => {
  // The token was malformed, but whatever was there is not worth leaving in
  // the address bar either.
  const { page } = landing("#subscription=confirm&token=nothex");
  await settle();
  assert.equal(page.location.hash, "");
});

/* ------------------------------------------------------------------ */
/* Worker answers                                                      */
/* ------------------------------------------------------------------ */

test("an already-confirmed link reads as done, not as an error", async () => {
  const { page } = landing(CONFIRM_HASH, () =>
    jsonResponse(200, { ok: true, status: "already_confirmed" })
  );
  await settle();
  page.action.click();
  await settle();

  assert.match(page.action.message, /already on the list/i);
});

test("confirming after an unsubscribe explains itself instead of failing blankly", async () => {
  const { page } = landing(CONFIRM_HASH, () =>
    jsonResponse(409, { ok: false, error: "unsubscribed" })
  );
  await settle();
  page.action.click();
  await settle();

  assert.match(page.action.message, /unsubscribed/i);
  assert.match(page.action.message, /subscription form/i);
  assert.equal(page.action.button.disabled, true, "a terminal state must not invite a retry");
});

test("a superseded confirm token offers a current link rather than a generic error", async () => {
  const { page } = landing(CONFIRM_HASH, () =>
    jsonResponse(404, { ok: false, error: "unknown_token" })
  );
  await settle();
  page.action.click();
  await settle();

  assert.match(page.action.message, /subscription form/i);
  assert.match(page.action.message, /current link/i);
  assert.equal(page.action.button.disabled, true, "a dead token cannot become valid on retry");
});

test("an unknown unsubscribe token reads as already unsubscribed", async () => {
  const { page } = landing(UNSUBSCRIBE_HASH, () =>
    jsonResponse(404, { ok: false, error: "unknown_token" })
  );
  await settle();
  page.action.click();
  await settle();

  assert.match(page.action.message, /already be unsubscribed/i);
  assert.equal(page.action.button.disabled, true, "a terminal result must not keep firing requests");
});

test("a successful action leaves the button disabled so it cannot be re-fired", async () => {
  const { page } = landing(CONFIRM_HASH);
  await settle();
  page.action.click();
  await settle();

  assert.equal(page.action.button.disabled, true);
});

test("a failed action re-enables the button so it can be retried", async () => {
  const { page } = landing(CONFIRM_HASH, () => jsonResponse(500, { ok: false }));
  await settle();
  page.action.click();
  await settle();

  assert.equal(page.action.button.disabled, false);
});

/* ------------------------------------------------------------------ */
/* Promises the page is in a position to make                          */
/* ------------------------------------------------------------------ */

test("the subscribe card does not promise one-click unsubscribe", async () => {
  // Following an unsubscribe link now lands here and asks first, so it is two
  // deliberate steps. Gmail's own List-Unsubscribe button is still one click,
  // but that is the mail client's affordance, not this page's to promise.
  const { page } = landing("");
  await settle();

  assert.doesNotMatch(
    page.subscribe.lead,
    /in a click|one[- ]click/i,
    "the page route is link-then-confirm, not one click"
  );
  assert.match(page.subscribe.lead, /unsubscribe link/i, "but it must still say how to get out");
});

/* ------------------------------------------------------------------ */
/* Deadline                                                            */
/* ------------------------------------------------------------------ */

test("an action that times out does not claim the service is unreachable", async () => {
  const { page } = landing(CONFIRM_HASH, hangs);
  await settle();
  page.action.click();
  await settle();

  page.clock.advance(60_000);
  await settle();

  assert.doesNotMatch(page.action.message, /could not reach/i);
  assert.match(page.action.message, /may still have gone through/i);
});

test("a timed-out action never tells the visitor to reload the page", async () => {
  // The one instruction guaranteed not to work: the token was scrubbed from
  // the address bar on load, so a reload lands on the plain status page with
  // nothing to act on. The retry is the button, or the link in the email.
  const { page } = landing(CONFIRM_HASH, hangs);
  await settle();
  page.action.click();
  await settle();
  page.clock.advance(60_000);
  await settle();

  assert.doesNotMatch(
    page.action.message,
    /reload the page and/i,
    "reloading loses the token — it cannot be the recovery advice"
  );
  assert.match(page.action.message, /button again/i, "the retry is here");
  assert.match(page.action.message, /link from the email/i, "and the fallback is the email");
  assert.equal(page.action.button.disabled, false, "so the button has to be usable again");
});

test("an action carries its own deadline, shorter than a subscribe's", async () => {
  // Confirm and unsubscribe are one conditional D1 write with no mail send, so
  // they have no reason to inherit the SMTP-sized budget.
  const { page } = landing(CONFIRM_HASH, hangs);
  await settle();
  page.action.click();

  const [armed] = page.clock.armed();
  assert.ok(armed > 0, "an action request must be bounded at all");
  assert.ok(armed < 30_000, `an action waited ${armed}ms, the subscribe budget`);
});
