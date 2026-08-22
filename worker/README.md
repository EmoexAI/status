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

The one thing still missing is a mail provider — see below.

## ⚠️ Sending is not wired up yet

`MAIL_PROVIDER` defaults to `none`. No provider has been chosen, so:

- `/api/health` reports `subscribe_enabled: false`
- the status page **keeps the subscribe card hidden** — visitors see no form
- `/api/subscribe` refuses with `503 subscriptions_closed` rather than
  storing addresses it could never confirm
- `/api/notify` answers `200 {skipped: true, reason: "mail_not_configured"}`
  so the incident workflow does not go permanently red, and does **not**
  consume the idempotency key — the first real send still works

Everything else is finished: storage, double opt-in, one-click unsubscribe,
rate limiting, idempotent fan-out, and the incident hook.

### Why not the existing Gmail path

`EmoEx-Task` sends mail over `smtp.gmail.com:587` with an App Password for
`info@emoexai.com`. It cannot be reused here — three independent blockers:

1. **No entry point.** Sending is a private Kotlin method inside a batch
   pipeline; there is no HTTP or gRPC route to it.
2. **`--ingress=internal`.** A Worker is outside GCP by definition. Reaching
   it would mean opening ingress and putting a long-lived GCP service-account
   key into Cloudflare.
3. **Wrong shape.** `sendText(to, subject, body)` is plain-text only
   (`setText(body, false)`, asserted in its tests) with no custom headers, so
   no `List-Unsubscribe` — which Gmail and Yahoo require from bulk senders.

Plus a ~2000/day Workspace ceiling and the domain reputation of a real human
mailbox riding on whatever a public signup form attracts.

### Plugging in a provider

Write a module exposing the `Mailer` contract in [`src/mailer.js`](src/mailer.js),
register a `case` in `createMailer`, set `MAIL_PROVIDER`. Nothing else in the
worker knows who delivers mail.

[`src/providers/resend.js`](src/providers/resend.js) is a complete worked
example (off by default, delete it if you go elsewhere). A provider must
support:

1. HTML body **plus** a plain-text alternative
2. Custom headers — specifically `List-Unsubscribe` and `List-Unsubscribe-Post`
3. Per-recipient delivery (never a shared `To`/`Cc`, which leaks the list)

Send from a **subdomain** (`mail.emoexai.com` or similar) with its own
SPF/DKIM/DMARC, so bulk reputation stays separate from `info@emoexai.com`.

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

`CLOUDFLARE_API_TOKEN` is intentionally **not** stored in GitHub: the token
carries DNS:Edit and Workers:Edit on the whole zone, and keeping a credential
of that blast radius in CI costs more than the automation saves for a worker
that changes this rarely. Deploy from a workstation with `npm run deploy`.
Revisit if this starts changing often.

## API

| Route                        | Auth   | Purpose                                             |
| ---------------------------- | ------ | --------------------------------------------------- |
| `GET  /api/health`           | —      | `{ ok, subscribe_enabled }`; gates the page's form  |
| `POST /api/subscribe`        | —      | `{ email }` → stores pending, mails a confirm link  |
| `GET  /api/confirm`          | token  | Marks confirmed, renders an HTML page               |
| `GET  /api/unsubscribe`      | token  | Renders an HTML page                                |
| `POST /api/unsubscribe`      | token  | RFC 8058 one-click, returns JSON                    |
| `POST /api/notify`           | Bearer | Fan-out to confirmed subscribers                    |

`/api/notify` payload:

```json
{ "action": "opened", "number": 42, "title": "🛑 API is down", "url": "https://github.com/EmoexAI/status/issues/42" }
```

## Design notes

- **Double opt-in.** Nothing is mailed to an address until someone clicks the
  link, so the form cannot be used to sign strangers up.
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
  confirmed" rather than a dead link.
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
- **Incidents do not trigger mail.** Issues created with the built-in
  `GITHUB_TOKEN` do **not** trigger workflows. Both monitors must open issues
  with `GH_PAT` — see the comment in `.github/workflows/cloud-run-monitor.yml`.
- **Logs.** `npm run tail`.
