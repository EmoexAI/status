/**
 * Gmail provider tests — all of them cover buildMime, because that is the
 * part with real risk. Gmail takes the whole RFC 5322 message as one blob,
 * so headers are assembled by string concatenation and a stray newline in
 * untrusted input becomes header injection. The JSON-bodied providers cannot
 * have this bug; this one can.
 *
 * Run: npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildMime } from "../src/providers/mime.js";

const FROM = "EmoEx Status <info@emoexai.com>";

const MAIL = {
  to: "reader@example.test",
  subject: "[EmoEx Status] API is down",
  html: "<p>API is down</p>",
  text: "API is down",
  headers: {
    "List-Unsubscribe": "<https://status-api.emoexai.com/api/unsubscribe?token=abc>",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  },
};

const headerBlock = (mime) => mime.split("\r\n\r\n")[0];

test("carries List-Unsubscribe — the header the old Kotlin helper could not", () => {
  const headers = headerBlock(buildMime(FROM, MAIL));
  assert.match(headers, /^List-Unsubscribe: <https:\/\/.*token=abc>$/m);
  assert.match(headers, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
});

test("sends multipart/alternative with both a text and an HTML part", () => {
  const mime = buildMime(FROM, MAIL);
  const boundary = mime.match(/boundary="([^"]+)"/)[1];

  assert.match(mime, /^MIME-Version: 1\.0$/m);
  assert.equal(mime.split(`--${boundary}`).length - 1, 3); // two parts + closer
  assert.match(mime, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(mime, /Content-Type: text\/html; charset="UTF-8"/);

  // Bodies are base64 of the UTF-8 source, not the raw source.
  assert.ok(!mime.includes("<p>API is down</p>"));
  assert.ok(mime.includes(Buffer.from(MAIL.html, "utf8").toString("base64")));
});

test("a newline in the subject cannot inject a header", () => {
  const mime = buildMime(FROM, {
    ...MAIL,
    subject: "Down\r\nBcc: attacker@evil.test",
  });

  assert.ok(!/^Bcc:/m.test(headerBlock(mime)));
  assert.match(headerBlock(mime), /^Subject: Down Bcc: attacker@evil\.test$/m);
});

test("a newline in the recipient or a custom header cannot inject either", () => {
  const mime = buildMime(FROM, {
    ...MAIL,
    to: "reader@example.test\r\nBcc: attacker@evil.test",
    headers: { "List-Unsubscribe": "<https://x.test>\r\nBcc: attacker@evil.test" },
  });

  assert.ok(!/^Bcc:/m.test(headerBlock(mime)));
  assert.equal(headerBlock(mime).match(/^To:/gm).length, 1);
});

test("a non-ASCII subject is RFC 2047 encoded rather than emitted raw", () => {
  // Incident subjects come from GitHub issue titles, which are not ASCII-only.
  const subject = "[EmoEx Status] 接口挂了";
  const headers = headerBlock(buildMime(FROM, { ...MAIL, subject }));

  assert.ok(!headers.includes("接口挂了"));
  assert.match(headers, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);

  const encoded = headers.match(/^Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/m)[1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), subject);
});

test("an ASCII subject is left readable", () => {
  assert.match(headerBlock(buildMime(FROM, MAIL)), /^Subject: \[EmoEx Status\] API is down$/m);
});

test("base64 bodies are wrapped at 76 columns", () => {
  const mime = buildMime(FROM, { ...MAIL, text: "x".repeat(500) });
  for (const line of mime.split("\r\n")) assert.ok(line.length <= 998, "SMTP line limit");
  assert.ok(mime.split("\r\n").some((line) => line.length === 76));
});
