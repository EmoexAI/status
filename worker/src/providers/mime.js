/**
 * RFC 5322 message construction, shared by both Gmail transports.
 *
 * Lives apart from either provider because SMTP and the REST API want the
 * exact same bytes — one writes them after DATA, the other base64url-encodes
 * them into a JSON field.
 */

/**
 * Assemble the message.
 *
 * Headers are built by string concatenation, so every interpolated value goes
 * through `headerSafe` first. A bare newline in an incident title would
 * otherwise inject arbitrary headers (`Bcc:` being the obvious one). Providers
 * that take a JSON body get this for free; these two do not.
 */
export function buildMime(from, mail) {
  const boundary = `emoex-${crypto.randomUUID()}`;

  const headers = [
    `From: ${headerSafe(from)}`,
    `To: ${headerSafe(mail.to)}`,
    `Subject: ${encodeSubject(mail.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  // List-Unsubscribe and friends. Both Gmail transports carry raw MIME, which
  // is why they can send these headers and the EmoEx-Task Kotlin sendText()
  // helper could not.
  for (const [name, value] of Object.entries(mail.headers || {})) {
    headers.push(`${headerSafe(name)}: ${headerSafe(value)}`);
  }

  return [
    ...headers,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(base64Utf8(mail.text)),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(base64Utf8(mail.html)),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** Strip the one character class that turns a value into a new header. */
export const headerSafe = (value) => String(value).replace(/[\r\n]+/g, " ").trim();

/**
 * RFC 2047. Incident subjects come from GitHub issue titles, which are not
 * guaranteed to be ASCII.
 */
function encodeSubject(subject) {
  const clean = headerSafe(subject);
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${base64Utf8(clean)}?=`;
}

// btoa() is latin1-only, so UTF-8 has to be widened to bytes by hand first.
export function base64Utf8(text) {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export const base64Url = (text) =>
  base64Utf8(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const wrap76 = (b64) => (b64.match(/.{1,76}/g) || []).join("\r\n");

/**
 * Extract the bare address for an SMTP envelope. `MAIL FROM` and `RCPT TO`
 * take an addr-spec only — a display name in there is a syntax error.
 */
export function bareAddress(value) {
  const angled = String(value).match(/<([^>]+)>/);
  return headerSafe(angled ? angled[1] : value);
}
