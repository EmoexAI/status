/**
 * Gmail over SMTP with an App Password — the live path.
 *
 * Sends as info@emoexai.com through smtp.gmail.com:587, the same way
 * EmoEx-Task does. Reachability from the edge was measured, not assumed:
 * TCP to :587 connects, STARTTLS upgrades, and the server advertises
 * `AUTH LOGIN PLAIN XOAUTH2` over the upgraded socket.
 *
 * Workers can do this because `cloudflare:sockets` exposes raw TCP plus
 * `startTls()`. The catch is that no SMTP client library runs in this
 * runtime, so the conversation below is hand-written — which is why the
 * response reader, the dot-stuffing and the timeouts all have tests.
 *
 * ⚠️ Every read is bounded. An unbounded read against a silent server would
 * hang the request until the Worker is killed, and during an incident that
 * is the notification failing at the one moment it exists for.
 */

import { buildMime, base64Utf8, bareAddress } from "./mime.js";

const HOST = "smtp.gmail.com";
const PORT = 587;
const EHLO_NAME = "status-api.emoexai.com";

const CONNECT_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 15_000;

// Gmail drops a session that runs too long, and one dead connection should
// not take a whole fan-out with it. Reconnecting every N messages bounds the
// damage while still amortising the TLS handshake and AUTH across a batch.
const MESSAGES_PER_CONNECTION = 25;

export function createGmailMailer(env) {
  const user = env.GMAIL_USER;
  const password = (env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, ""); // Google shows it in groups of four
  const from = env.MAIL_FROM;

  if (!user || !password || !from) {
    console.error("MAIL_PROVIDER=gmail but GMAIL_USER, GMAIL_APP_PASSWORD or MAIL_FROM is missing");
    return {
      name: "gmail",
      configured: false,
      async send() {
        return { ok: false, error: "mail_not_configured" };
      },
      async sendMany(mails) {
        return { sent: 0, failures: mails.map((m) => ({ to: m.to, error: "mail_not_configured" })) };
      },
    };
  }

  const creds = { user, password };

  async function sendMany(mails) {
    let sent = 0;
    const failures = [];

    for (let i = 0; i < mails.length; i += MESSAGES_PER_CONNECTION) {
      const slice = mails.slice(i, i + MESSAGES_PER_CONNECTION);
      let session;

      try {
        session = await openSession(creds);
      } catch (error) {
        // Could not even get a session: fail this slice and try the next one
        // rather than abandoning every remaining recipient.
        failures.push(...slice.map((m) => ({ to: m.to, error: describe(error) })));
        continue;
      }

      try {
        for (let j = 0; j < slice.length; j += 1) {
          const mail = slice[j];
          try {
            await deliver(session, from, mail);
            sent += 1;
          } catch (error) {
            failures.push({ to: mail.to, error: describe(error) });

            // A per-recipient rejection leaves the session usable once the
            // half-finished transaction is cleared. Anything else means the
            // connection itself is gone — give up on the rest of this slice.
            if (!(error instanceof SmtpError) || !(await reset(session))) {
              failures.push(
                ...slice.slice(j + 1).map((m) => ({ to: m.to, error: describe(error) }))
              );
              break;
            }
          }
        }
      } finally {
        await close(session);
      }
    }

    return { sent, failures };
  }

  return {
    name: "gmail",
    configured: true,
    async send(mail) {
      const { sent, failures } = await sendMany([mail]);
      return sent === 1 ? { ok: true } : { ok: false, error: failures[0]?.error || "unknown_error" };
    },
    sendMany,
  };
}

/* ------------------------------------------------------------------ */
/* SMTP session                                                        */
/* ------------------------------------------------------------------ */

async function openSession(creds) {
  // Imported here rather than at module scope so the file stays importable
  // under `node --test`, where `cloudflare:sockets` does not exist.
  const { connect } = await import("cloudflare:sockets");

  const socket = connect({ hostname: HOST, port: PORT }, { secureTransport: "starttls" });
  await withTimeout(socket.opened, CONNECT_TIMEOUT_MS, "connect");

  let wire = attach(socket.readable, socket.writable);

  const banner = await wire.response();
  if (banner.code !== 220) throw new SmtpError(banner.code, `banner: ${banner.text}`);

  await wire.command(`EHLO ${EHLO_NAME}`, [250]);
  await wire.command("STARTTLS", [220]);

  // Everything above was plaintext. Credentials only ever cross the upgraded
  // socket, so the reader is re-attached before AUTH and not a line earlier.
  wire.release();
  const secure = socket.startTls();
  wire = attach(secure.readable, secure.writable);

  await wire.command(`EHLO ${EHLO_NAME}`, [250]);
  await wire.command("AUTH LOGIN", [334]);
  await wire.command(base64Utf8(creds.user), [334], "AUTH LOGIN <username>");
  await wire.command(base64Utf8(creds.password), [235], "AUTH LOGIN <password>");

  return { socket, wire };
}

async function deliver(session, from, mail) {
  const { wire } = session;

  await wire.command(`MAIL FROM:<${bareAddress(from)}>`, [250]);
  await wire.command(`RCPT TO:<${bareAddress(mail.to)}>`, [250, 251]);
  await wire.command("DATA", [354]);

  const body = dotStuff(buildMime(from, mail));
  await wire.write(`${body.endsWith("\r\n") ? body : `${body}\r\n`}.`);

  const accepted = await wire.response();
  if (accepted.code !== 250) throw new SmtpError(accepted.code, `DATA: ${accepted.text}`);
}

/** Clear a half-finished transaction. Returns false if the session is dead. */
async function reset(session) {
  try {
    await session.wire.command("RSET", [250]);
    return true;
  } catch {
    return false;
  }
}

async function close(session) {
  try {
    await session.wire.write("QUIT");
  } catch {
    // Already gone; closing the socket below is what actually matters.
  }
  try {
    session.wire.release();
    await session.socket.close();
  } catch {
    /* nothing useful to do */
  }
}

/* ------------------------------------------------------------------ */
/* Wire protocol                                                       */
/* ------------------------------------------------------------------ */

function attach(readable, writable) {
  const reader = readable.getReader();
  const writer = writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  async function response() {
    for (;;) {
      const complete = takeResponse(buffer);
      if (complete) {
        buffer = complete.rest;
        return complete;
      }
      const chunk = await withTimeout(reader.read(), READ_TIMEOUT_MS, "read");
      if (chunk.done) throw new Error("connection closed by server");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  async function write(line) {
    await writer.write(encoder.encode(`${line}\r\n`));
  }

  async function command(line, expected, label) {
    await write(line);
    const reply = await response();
    if (!expected.includes(reply.code)) {
      // `label` exists so AUTH never puts the App Password in a log line.
      throw new SmtpError(reply.code, `${label || line.split(" ")[0]}: ${reply.text}`);
    }
    return reply;
  }

  return {
    response,
    write,
    command,
    release() {
      try {
        reader.releaseLock();
        writer.releaseLock();
      } catch {
        /* already released */
      }
    },
  };
}

/**
 * Pull one complete reply out of the buffer.
 *
 * SMTP replies are multi-line — `250-` continues, `250 ` (space) ends — and a
 * single TCP read is not guaranteed to hold a whole reply, or to hold only
 * one. Both cases show up against Gmail in practice: its EHLO response is
 * eight lines. Returns null while the reply is still incomplete.
 */
export function takeResponse(buffer) {
  const lines = buffer.split("\r\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\d{3} /.test(lines[i])) {
      return {
        code: Number(lines[i].slice(0, 3)),
        text: lines.slice(0, i + 1).join(" | "),
        rest: lines.slice(i + 1).join("\r\n"),
      };
    }
  }
  return null;
}

/**
 * RFC 5321 §4.5.2. A line consisting of a single "." ends the DATA block, so
 * any body line that starts with "." must be doubled or the message is cut
 * short there — and base64 output can legitimately begin with one.
 */
export function dotStuff(message) {
  return message.replace(/\r\n\./g, "\r\n..").replace(/^\./, "..");
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class SmtpError extends Error {
  constructor(code, detail) {
    super(`${code} ${detail}`);
    this.name = "SmtpError";
    this.code = code;
  }
}

/**
 * Gmail reports an exhausted quota as 550 5.4.5 / 452 4.2.1. Worth naming,
 * because the blast radius is not this mailing list — it is info@ being
 * unable to send anything at all until the limit rolls over.
 */
function describe(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/5\.4\.5|4\.2\.1|sending limit|quota/i.test(message)) {
    console.error("gmail quota exhausted — info@ is likely blocked for ~24h", message);
    return `quota_exhausted ${message}`.slice(0, 300);
  }
  return message.slice(0, 300);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`smtp timeout during ${label}`)), ms);
    }),
  ]);
}
