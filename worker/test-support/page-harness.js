/**
 * Runs the status page's injected script under test.
 *
 * The script lives in the `js:` block of ../../.upptimerc.yml, which nothing
 * compiles and nothing type-checks — inline page JS shipping unexercised is
 * exactly how the 8s-deadline bug reached production. This harness executes it
 * for real against stub globals, so the tests assert behaviour rather than
 * pattern-matching the file.
 *
 * ⚠️ Deliberately outside test/, so node's test runner does not try to
 * discover it as a test file.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

/**
 * Pull the `js: |` block out of the Upptime config.
 *
 * A literal block scalar, so the body is every following line indented past
 * the key. Done by hand rather than with a YAML parser: the worker has no
 * dependencies and this is not worth adding the first one for.
 */
export function pageScript() {
  const lines = readFileSync(new URL("../../.upptimerc.yml", import.meta.url), "utf8").split("\n");
  const start = lines.findIndex((line) => /^\s{2}js:\s*\|\s*$/.test(line));
  assert.notEqual(start, -1, "the js: block is gone from .upptimerc.yml");

  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !line.startsWith("    ")) break;
    body.push(line.slice(4));
  }
  return body.join("\n");
}

/**
 * Timers under test control. Real ones would make "did it give up at 8s or at
 * 30s?" a race; here the delay each request asks for is simply readable.
 */
export function fakeClock() {
  const pending = new Map();
  let nextId = 1;

  return {
    setTimeout(fn, delay) {
      pending.set(nextId, { fn, delay });
      return nextId++;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    /** Delays currently armed — one per in-flight request. */
    armed() {
      return [...pending.values()].map((t) => t.delay);
    },
    /** Fire every timer due within `ms`. */
    advance(ms) {
      for (const [id, timer] of [...pending]) {
        if (timer.delay <= ms) {
          pending.delete(id);
          timer.fn();
        }
      }
    },
  };
}

/** Just enough DOM for the card builders and whenContainer(). */
function fakeDom(options = {}) {
  const make = (tag) => ({
    tag,
    id: "",
    parentNode: null,
    children: [],
    listeners: {},
    attributes: {},
    className: "",
    textContent: "",
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      if (options.onMutation) options.onMutation();
      return child;
    },
    insertBefore(child, reference) {
      const at = reference ? this.children.indexOf(reference) : -1;
      child.parentNode = this;
      if (at < 0) this.children.push(child);
      else this.children.splice(at, 0, child);
      if (options.onMutation) options.onMutation();
      return child;
    },
    replaceChild(child, replaced) {
      const at = this.children.indexOf(replaced);
      assert.notEqual(at, -1, "replaceChild target is not a child");
      child.parentNode = this;
      replaced.parentNode = null;
      this.children.splice(at, 1, child);
      if (options.onMutation) options.onMutation();
      return replaced;
    },
    get firstChild() {
      return this.children[0] || null;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    focus() {
      focused.push(this);
    },
  });

  const focused = [];
  let container = make("main");
  let containerPresent = options.containerPresent !== false;
  const byId = () => container.children;

  return {
    get container() {
      return container;
    },
    focused,
    setContainerPresent(present) {
      containerPresent = present;
      if (options.onMutation) options.onMutation();
    },
    replaceContainer() {
      container = make("main");
      containerPresent = true;
      if (options.onMutation) options.onMutation();
    },
    document: {
      readyState: options.readyState || "complete",
      documentElement: make("html"),
      createElement: make,
      querySelector: (selector) =>
        selector === "main.container" && containerPresent ? container : null,
      getElementById: (id) => byId().find((child) => child.id === id) || null,
    },
  };
}

/** Settle whatever promise chain the script is driving. */
export const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A request that never answers, but honours abort — like a slow SMTP send. */
export const hangs = (_url, options) =>
  new Promise((_, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      reject(error);
    });
  });

/** A JSON response, shaped the way the script consumes one. */
export const jsonResponse = (status, body) => Promise.resolve({ status, json: async () => body });

export const healthOk = () => jsonResponse(200, { ok: true, subscribe_enabled: true });

/**
 * Execute the page script against stubs and expose what a visitor would see.
 *
 * @param {Function} fetchImpl          stands in for window.fetch
 * @param {object}   [options]
 * @param {string}   [options.hash]     initial location.hash, e.g. "#subscription=confirm&token=…"
 */
export function loadPage(fetchImpl, options = {}) {
  const clock = fakeClock();
  const mutationObservers = [];
  let mutationScheduled = false;
  const notifyMutation = () => {
    // Real MutationObserver callbacks run after the current DOM operation,
    // never recursively in the middle of appendChild/buildActionCard.
    if (mutationScheduled) return;
    mutationScheduled = true;
    queueMicrotask(() => {
      mutationScheduled = false;
      for (const observer of mutationObservers) {
        if (observer.active) observer.callback();
      }
    });
  };
  const dom = fakeDom({ ...options, onMutation: notifyMutation });

  const replaceStateCalls = [];
  const location = { hash: options.hash || "", pathname: "/", search: "" };
  const history = {
    replaceState(_state, _title, url) {
      replaceStateCalls.push(url);
      // A real replaceState with a fragmentless URL clears location.hash.
      location.hash = "";
    },
  };
  const listeners = new Map();
  const win = {
    location,
    history,
    addEventListener(type, fn, settings) {
      const entries = listeners.get(type) || [];
      entries.push({ fn, once: Boolean(settings && settings.once) });
      listeners.set(type, entries);
    },
  };

  const dispatch = (type) => {
    const entries = [...(listeners.get(type) || [])];
    listeners.set(
      type,
      entries.filter((entry) => !entry.once)
    );
    for (const entry of entries) entry.fn();
  };

  vm.runInNewContext(pageScript(), {
    window: win,
    location,
    history,
    document: dom.document,
    fetch: fetchImpl,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    AbortController,
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.active = false;
        mutationObservers.push(this);
      }
      observe() {
        this.active = true;
      }
      disconnect() {
        this.active = false;
      }
    },
  });

  const card = (id) => dom.container.children.find((child) => child.id === id) || null;
  const descend = (node) =>
    node.children.flatMap((child) => [child, ...descend(child)]);
  const within = (id, tag, classPrefix) =>
    descend(card(id)).find((el) => el.tag === tag && el.className.startsWith(classPrefix));

  const surface = (id) => ({
    get present() {
      return card(id) !== null;
    },
    get element() {
      return card(id);
    },
    get heading() {
      return descend(card(id)).find((el) => /^h[1-6]$/.test(el.tag)).textContent;
    },
    get lead() {
      return within(id, "p", "maillist-lead").textContent;
    },
    get message() {
      return within(id, "p", "maillist-msg").textContent;
    },
    get button() {
      return descend(card(id)).find((el) => el.tag === "button") || null;
    },
    get form() {
      return descend(card(id)).find((el) => el.tag === "form") || null;
    },
    click() {
      this.form.listeners.submit[0]({ preventDefault() {} });
    },
  });

  // Built, not spread: these are getters, and spreading would evaluate every
  // one of them now — before the cards the script mounts asynchronously exist.
  const subscribe = surface("maillist");
  subscribe.submit = function submit(email) {
    const form = this.form;
    form.children.find((child) => child.tag === "input").value = email;
    form.listeners.submit[0]({ preventDefault() {} });
  };

  return {
    clock,
    location,
    replaceStateCalls,
    finishLoad({ replaceContainer = false } = {}) {
      if (replaceContainer) dom.replaceContainer();
      else dom.setContainerPresent(true);
      dom.document.readyState = "complete";
      dispatch("load");
    },
    replaceMain() {
      dom.replaceContainer();
    },
    navigateHash(hash) {
      location.hash = hash;
      dispatch("hashchange");
    },
    /** Elements the script called focus() on, in order. */
    focused: dom.focused,
    /** The order cards sit in main.container. */
    get order() {
      return dom.container.children.map((child) => child.id);
    },
    /** The subscribe form card. */
    subscribe,
    /** The confirm/unsubscribe card that a mail link lands on. */
    action: surface("maillist-action"),
  };
}

/** Load a page whose /api/health succeeds, and wait for the subscribe card. */
export async function pageWithSubscribeCard(subscribeFetch, options = {}) {
  const page = loadPage((url, opts) => {
    if (url.endsWith("/api/health")) return healthOk();
    return subscribeFetch(url, opts);
  }, options);

  await settle();
  assert.ok(page.subscribe.present, "the subscribe card should have mounted");
  return page;
}
