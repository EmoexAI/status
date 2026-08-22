-- EmoEx Status MailList — D1 schema.
--
-- Apply with:
--   wrangler d1 execute emoex-status-maillist --remote --file=./schema.sql
--
-- Re-runnable: every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS subscribers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  email             TEXT    NOT NULL UNIQUE,
  -- pending | confirmed | unsubscribed
  status            TEXT    NOT NULL DEFAULT 'pending',
  -- Kept (not nulled) after confirmation so a second click on the same link
  -- shows "already confirmed" instead of a dead link.
  confirm_token     TEXT    NOT NULL UNIQUE,
  unsubscribe_token TEXT    NOT NULL UNIQUE,
  created_at        TEXT    NOT NULL,
  confirmed_at      TEXT,
  unsubscribed_at   TEXT,
  -- Throttles confirmation re-sends so re-submitting the form cannot be used
  -- to mail-bomb a third party's inbox.
  last_sent_at      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers (status);

-- Idempotency guard for /api/notify. A GitHub Actions re-run replays the same
-- (issue, action) pair; without this every re-run would mail everyone again.
CREATE TABLE IF NOT EXISTS notifications (
  key        TEXT PRIMARY KEY,   -- "<issue-number>:<action>"
  sent_at    TEXT NOT NULL,
  recipients INTEGER NOT NULL DEFAULT 0
);

-- Fixed-window rate limiter. Rows are self-expiring in effect: window_start is
-- overwritten whenever a new window begins, so the table stays bounded by the
-- number of distinct keys, not by request volume.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT    PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
