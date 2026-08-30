# MailList worker

Public email subscription list for [status.emoexai.com](https://status.emoexai.com).
Visitors subscribe on the status page; when an incident opens or closes,
GitHub Actions calls this worker and it mails everyone who confirmed.

Runs on Cloudflare, **not** in GKE — on purpose. The status page exists to
work during a full GCP outage, which is exactly when subscribers need the
email. A notifier hosted on the infrastructure it reports on fails at the
only moment it matters.

## Current state

Deployed and live at **https://status-api.emoexai.com** (D1 `emoex-status-maillist`,
region APAC). Verified: health, auth on `/api/notify`, `503` on `/api/subscribe`.

Mail goes out over **Gmail SMTP as `info@emoexai.com`**.

## Sending

`MAIL_PROVIDER=gmail`. Sending switches on when both `GMAIL_*` secrets are
set; until then the provider reports `configured: false`, `/api/health`
answers `subscribe_enabled: false`, the status page keeps the subscribe card
hidden and `/api/subscribe` refuses with `503`. Deploying ahead of the
credentials is therefore safe.

### How it sends

SMTP to `smtp.gmail.com:587`, STARTTLS, `AUTH LOGIN` with an App Password —
the same transport and the same mailbox as `EmoEx-Task`
(`application-production.properties`: `info@emoexai.com` +
`sm://emoex-gmail-app-password`).

Reachability from the Cloudflare edge was measured, not assumed:

```
-- tcp established to smtp.gmail.com:587
< 220 smtp.gmail.com ESMTP ... - gsmtp
> EHLO / STARTTLS
< 220 2.0.0 Ready to start TLS
-- startTls()
< 250-AUTH LOGIN PLAIN XOAUTH2 PLAIN-CLIENTTOKEN OAUTHBEARER XOAUTH
```

Workers can do this because `cloudflare:sockets` gives raw TCP plus
`startTls()`. What they do not have is an SMTP client library, so
[`src/providers/gmail.js`](src/providers/gmail.js) writes the conversation by
hand. Three parts of that are easy to get wrong and each has tests:

- **Multi-line replies.** `250-` continues, `250 ` ends. Gmail's EHLO reply is
  eight lines, and one TCP read holds neither exactly one reply nor a whole
  one — `takeResponse` buffers until a terminating line arrives.
- **Dot-stuffing.** A body line of just `.` ends DATA early. base64 output can
  legitimately start with one, so leading dots are doubled (RFC 5321 §4.5.2).
- **Timeouts.** Every read is bounded. An unbounded read against a silent
  server hangs the request until the Worker is killed — during an incident,
  that is the notification failing at the one moment it exists for.

Connections are reused across 25 messages per batch to amortise the TLS
handshake and AUTH, then rotated. A per-recipient rejection is cleared with
`RSET` and the batch continues; a connection-level failure fails the rest of
that batch and the next one reconnects.

### How long a subscribe takes

The status page waits on three routes — `/api/subscribe`, `/api/confirm` and
`/api/unsubscribe` — but only the first waits on a *mail send*. The other two
are a single conditional D1 write and answer in milliseconds, which is why
they carry a shorter deadline on the page.

`POST /api/subscribe` waits on the whole SMTP conversation above: a dozen
round trips to Gmail — connect, STARTTLS, AUTH, the message, the `250` —
before a reply is possible at all, plus the D1 queries either side. It is
therefore **as slow as Gmail is**, and that is a multi-round-trip conversation
rather than one request.

**Measured once, 2026-08-30.** A production `POST /api/subscribe` with a valid
address answered `200` with the generic confirmation-sent message in **7.5s**
(time to first byte; connect was negligible at 4ms, so the time is the worker,
not the network).

⚠️ That is **one sample, not a distribution** — it does not bound the slow end,
and nothing here should be read as a p99. What it does establish is the
margin: a *successful* send finished under half a second inside the old 8s
browser deadline. Ordinary run-to-run variation crosses a gap that small,
which is the whole of the "could not reach the subscription service" report.

⚠️ The status page's `SUBSCRIBE_TIMEOUT_MS` (`../.upptimerc.yml`) has to be
sized for the slow end of that, not the average. It was originally 8s, shared
with `/api/health`, and a healthy send can outlive it: the browser aborts and
the page reports "could not reach the subscription service" for a subscription
that may still succeed. `test/subscribe-deadline.test.js` runs the page script
and fails if that deadline is shared or shortened again.

The worker deliberately does **not** impose a shorter deadline of its own.
It could only do that by answering while the send is still in flight, which
buys a bounded response time at the price of never knowing whether the mail
went out — and the page cannot use that answer for anything better than what
it already says on its own timeout. Bounding the request would mean bounding
the *send*, in the provider, where cancellation is real.

### Credentials

Two secrets, both already existing facts rather than new provisioning:

```bash
echo -n 'info@emoexai.com' | wrangler secret put GMAIL_USER
gcloud secrets versions access latest \
  --secret=emoex-gmail-app-password --project=emoex-9aa45 \
  | wrangler secret put GMAIL_APP_PASSWORD
```

Sending stays off until both are set: the provider reports
`configured: false`, `/api/health` answers `subscribe_enabled: false` and the
status page keeps the subscribe card hidden. Deploying ahead of them is safe.

⚠️ This is the **same App Password EmoEx-Task uses**. Rotating it in Google
breaks both, and revoking it because of one breaks the other. A second App
Password on the same account costs nothing and makes them independently
revocable — worth doing if this list ever outlives the experiment.

⚠️ An App Password is scoped to the *account*, not to sending: it also grants
IMAP and POP on `info@`. If a send-only credential is ever wanted,
[`src/providers/gmail-oauth.js`](src/providers/gmail-oauth.js) is a working
OAuth implementation of the same contract, scoped to `gmail.send` — switch
with `MAIL_PROVIDER=gmail-oauth`.

### Deliverability

Checked 2026-08-23 against live DNS. `emoexai.com` publishes SPF
(`include:_spf.google.com`) and `_dmarc` at `p=none`; MX is Google Workspace.

**There is no aligned DKIM key, and that is survivable.** We never sign
anything ourselves — Google's outbound servers do it — and with no custom key
configured they sign under a `…gappssmtp.com` domain. DKIM therefore *passes*
but is not aligned with `From: emoexai.com`. DMARC still passes on the other
leg: `MAIL FROM` is `info@emoexai.com` (see `deliver()` in
[`src/providers/gmail.js`](src/providers/gmail.js)) and the mail leaves via
Google's IPs, so SPF passes *and* aligns. At `p=none` nothing is rejected
either way, and the 800/day cap keeps us far below the 5,000/day threshold
where Gmail and Yahoo start demanding both.

What the gap actually costs:

- **Forwarded mail loses SPF**, and with DKIM unaligned the whole DMARC check
  then fails. Harmless under `p=none`; it is spam-folder pressure, not bounces.
- ⚠️ **Do not tighten `_dmarc` to `p=quarantine` or `p=reject` before adding an
  aligned DKIM key.** Today that change would quarantine our own forwarded
  outage notices — the mail people most need to receive.

Adding one is DNS plus a console visit, no code: Google Admin → Apps → Google
Workspace → Gmail → Authenticate email → generate a 2048-bit key → publish it
as TXT `google._domainkey.emoexai.com` → Start authentication. ⚠️ The existing
`s1`/`s2._domainkey` records belong to Wix/SendGrid — leave them alone.

### Switching providers later

Write a module exposing the `Mailer` contract in [`src/mailer.js`](src/mailer.js),
register a `case` in `createMailer`, set `MAIL_PROVIDER`. Nothing else in the
worker knows who delivers mail, and the daily budget wraps whoever it is.

[`src/providers/resend.js`](src/providers/resend.js) is a second worked
example (off, kept as reference). Any provider must support:

1. HTML body **plus** a plain-text alternative
2. Custom headers — specifically `List-Unsubscribe` and `List-Unsubscribe-Post`
3. Per-recipient delivery (never a shared `To`/`Cc`, which leaks the list)

If bulk volume ever justifies moving off `info@`, send from a **subdomain**
(`mail.emoexai.com`) with its own SPF/DKIM/DMARC, so list reputation stops
riding on a real human mailbox.

## Setup

Requires Cloudflare API token permissions: Workers Scripts:Edit,
Workers Routes:Edit, D1:Edit, DNS:Edit, Zone:Read on `emoexai.com`.

Already done for the current deployment — kept here for reference and for
rebuilding from scratch.

```bash
cd worker
export CLOUDFLARE_API_TOKEN="$(op read 'op://Emoex/EmoEx Cloudflare Token/CLOUDFLARE_API_TOKEN')"
export CLOUDFLARE_ACCOUNT_ID=fe29207a28d7267afdc23baf5773e0f8
npm install

# 1. Create the database, then paste the printed id into wrangler.jsonc
npx wrangler d1 create emoex-status-maillist

# 2. Create the tables
npm run db:init

# 3. Shared secret for the incident hook — same value goes into the repo
#    secret MAILLIST_NOTIFY_SECRET (Settings → Secrets and variables → Actions)
openssl rand -hex 32
npx wrangler secret put NOTIFY_SECRET

# 4. Deploy (creates the status-api.emoexai.com DNS record too)
npm run deploy
```

Then set on the GitHub repo:

| Kind     | Name                       | Value                              |
| -------- | -------------------------- | ---------------------------------- |
| Variable | `MAILLIST_ENDPOINT`        | `https://status-api.emoexai.com`   |
| Variable | `CLOUDFLARE_ACCOUNT_ID`    | `fe29207a28d7267afdc23baf5773e0f8` |
| Secret   | `MAILLIST_NOTIFY_SECRET`   | same value as `NOTIFY_SECRET`      |
| Secret   | `CLOUDFLARE_API_TOKEN`     | *deliberately unset* — see below   |

`.github/workflows/maillist-deploy.yml` redeploys on every push to `worker/**`
and skips (rather than fails) while the Cloudflare credentials are unset.

### ⚠️ Deploy order: static site first, then the Worker

These two halves are coupled in one direction, so the order is not a
preference:

1. **Merge and publish the status page first.** The confirm/unsubscribe UI
   lives in the `js:` block of `../.upptimerc.yml`, and GitHub Pages serves it.
   Wait for the site workflow to finish and check the page actually handles a
   fragment — open
   `https://status.emoexai.com/#subscription=confirm&token=<64 hex>` and
   confirm the card renders and the URL is scrubbed. (Any 64-hex string will
   do; an unknown token is a clean 404 from the API and mutates nothing.)
2. **Then deploy the Worker** with `npm run deploy`.

Backwards, there is a window where the worker mails links to
`status.emoexai.com/#subscription=…` and the live page does not yet know what
a `subscription` fragment is. Those links land on a status page that silently
ignores them — the visitor sees the ordinary page and no way to confirm, and
the fragment never reaches a server, so nothing is logged and nobody finds out.
Starting a new subscription after an unsubscribe rotates the confirmation
token, so an old link cannot put that address back on the list. A resend while
the row is still pending reuses its token, preserving a link that may already
have been delivered.

Page-first is safe at every moment, but not because of the redirects — the
old worker does not have them yet. What actually happens: mail already sent
carries `status-api` links, and until step 2 the *old* worker answers those
with its own HTML page, exactly as it does today. After step 2 the same links
hit the new `GET` handlers and redirect to a status page that by then
understands the fragment. Neither window has a broken link in it.

`CLOUDFLARE_API_TOKEN` is intentionally **not** stored in GitHub: the token
carries DNS:Edit and Workers:Edit on the whole zone, and keeping a credential
of that blast radius in CI costs more than the automation saves for a worker
that changes this rarely. Deploy from a workstation with `npm run deploy`.
Revisit if this starts changing often.

## API

| Route                        | Auth   | Purpose                                              |
| ---------------------------- | ------ | ---------------------------------------------------- |
| `GET  /api/health`           | —      | `{ ok, subscribe_enabled }`; gates the page's form   |
| `POST /api/subscribe`        | —      | `{ email }` → stores pending, mails a confirm link   |
| `POST /api/confirm`          | body   | `{ token }` → pending becomes confirmed              |
| `GET  /api/confirm`          | —      | 303 to the status page. **Mutates nothing**          |
| `POST /api/unsubscribe`      | body   | `{ token }` from the status page, returns JSON       |
| `POST /api/unsubscribe?token=` | query | RFC 8058 one-click, for mail clients                |
| `GET  /api/unsubscribe`      | —      | 303 to the status page. **Mutates nothing**          |
| `POST /api/notify`           | Bearer | Fan-out to confirmed subscribers                     |

`/api/notify` payload:

```json
{ "action": "opened", "number": 42, "title": "🛑 API is down", "url": "https://github.com/EmoexAI/status/issues/42" }
```

## Where the user-visible pages live

**On `status.emoexai.com`, not here.** This worker serves no HTML at all. Mail
links to:

```
https://status.emoexai.com/#subscription=<confirm|unsubscribe>&token=<64 hex>
```

and the page's `js:` block (`../.upptimerc.yml`) renders a card and does the
work. Three things make that shape worth the indirection:

- **The token is in the fragment.** A fragment is never sent to a server, so
  the token stays out of GitHub Pages' request logs, out of anything in front
  of them, and out of the `Referer` of every asset the page loads. A query
  string would be in all three.
- **The page scrubs it immediately**, via `history.replaceState`, before any
  network call — so it does not linger in the address bar, in session history,
  or in whatever the visitor copy-pastes to a colleague.
- **On this route, nothing happens until a click.** Gmail's scanner, chat link
  previews and browser prefetch all fetch URLs with no human present. That is
  why the legacy `GET`s here only redirect: a `GET` that confirmed a
  subscription would be a double opt-in that opted nobody in. ⚠️ Scoped to the
  browser route on purpose — `POST /api/unsubscribe?token=` below still acts
  directly, with no page and no click, because RFC 8058 requires it to.

The redirects carry `Cache-Control: no-store`, `Referrer-Policy: no-referrer`
and `X-Robots-Tag: noindex, nofollow`. A malformed or missing token still
redirects — to `#subscription=invalid` — so this endpoint cannot be used as a
token oracle.

⚠️ **`List-Unsubscribe` is the one exception and must stay on the API.** Gmail
and Yahoo POST that URL themselves with no browser involved, so RFC 8058
requires it to act directly. Incident mail therefore carries two different
unsubscribe URLs: the status-page one a person clicks, and the API one in the
header. Changing the header to the status page would break one-click
unsubscribe and, with it, bulk-sender deliverability.

## Token lifecycle

| Token               | Rotated when                                   | Why                                                                 |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| `confirm_token`     | on unsubscribe and when reviving that address  | It is the capability to *add* an address. One sitting in an old inbox must not survive an unsubscribe; pending resends reuse the current token so a failed send cannot kill the last delivered link |
| `unsubscribe_token` | never                                          | It is the capability to *remove*, it is already in every message ever sent, and rotating it would break idempotent unsubscribe and the `List-Unsubscribe` header in delivered mail |

Consequences worth knowing:

- **A new cycle supersedes the previous cycle.** Returning after an unsubscribe
  creates a fresh confirmation token. Re-sending within one pending cycle
  deliberately preserves the same token, so every delivered copy still works.
- **Confirmation is pending-only, enforced in the `WHERE` clause** — one
  conditional `UPDATE`, not a read followed by a write. As a read-then-write,
  an unsubscribe landing between the two would be silently undone.
- Clicking a confirm link twice reads as "already confirmed" rather than a dead
  link: success does not consume the token.

## Design notes

- **Double opt-in.** The form can send a confirmation email, but no status
  alerts are sent until the recipient explicitly confirms on the status page.
- **No enumeration.** New, pending and already-confirmed addresses all get the
  same response, so `/api/subscribe` cannot test list membership.
- **Re-send cooldown.** 5 minutes between confirmations to one address, plus
  5/hour per IP and 200/hour globally. Without this the form is an open
  mail-bomb relay pointed at whatever address an attacker types.
- **Rate limiter fails open.** A broken limiter should not take the form down.
- **Idempotent fan-out.** `notifications` claims `<issue>:<action>` before
  sending, so a workflow re-run does not mail the list twice. The claim is
  released if nothing went out, so a genuine retry still works.
- **Confirm tokens are not consumed**, so a second click reads as "already
  confirmed" rather than a dead link. They *are* rotated on unsubscribe and
  when that address starts a new subscription cycle — see **Token lifecycle**.
- **No action on `GET`.** Everything that fetches a link without a human —
  mail scanners, link previews, prefetch — uses `GET`, so `GET` only redirects
  and the mutation waits for a click on the status page. The deliberate
  exception is the RFC 8058 one-click `POST`, which mail clients send
  themselves; it is a `POST`, so none of those fetchers reach it.
- **One message per recipient**, always — never a shared `To`/`Cc`.

## Testing

```bash
npm test        # node's built-in runner, no dependencies
```

The suite covers the shipped no-provider state and asserts the guards sit in
*front* of the database — `env.DB` is a Proxy that throws, so any query on
those paths fails the test. Paths that do use D1 need a local database:

```bash
npm run db:local && npm run dev
```

## Troubleshooting

- **The subscribe card never appears.** By design until a provider is set —
  check `curl https://status-api.emoexai.com/api/health` for
  `subscribe_enabled`. If it is `true` and the card is still missing, check
  the browser console for a CORS error and confirm the page's origin is in
  `ALLOWED_ORIGINS`.
- **Subscribing says "could not reach the subscription service".** That text
  is the page's `fetch`-rejected branch, so the request never completed — it
  is not the worker returning an error, and every status the worker *does*
  return has a message of its own. Check the browser console for a CORS
  failure (origin missing from `ALLOWED_ORIGINS`). If the page instead says
  the confirmation "may still arrive", it gave up waiting rather than failed:
  see **How long a subscribe takes** above.
- **Incidents do not trigger mail.** Issues created with the built-in
  `GITHUB_TOKEN` do **not** trigger workflows. Both monitors must open issues
  with `GH_PAT` — see the comment in `.github/workflows/cloud-run-monitor.yml`.
- **Logs.** `npm run tail`.
