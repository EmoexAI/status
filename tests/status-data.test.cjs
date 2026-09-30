const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHistory, daysFor, overall } = require('../assets/status.js');
const day = 86400000;
const now = Date.parse('2026-09-30T12:00:00Z');
const history = parseHistory('status: up\nlastUpdated: 2026-09-30T01:52:29.587Z\nstartTime: 2026-06-21T01:51:45.695Z\nresponseTime: 925\n');

test('health requires all checks and successful incident lookup; known failures win', () => {
  assert.equal(overall([history], []), 'up');
  assert.equal(overall([history], null), 'unknown');
  assert.equal(overall([history, null], []), 'unknown');
  assert.equal(overall([], []), 'unknown');
  assert.equal(overall([{ ...history, status: 'down' }, null], null), 'down');
  assert.equal(overall([history], [{ title: 'Background task is degraded' }]), 'degraded');
  assert.equal(overall([history], [{ title: 'API is down' }]), 'down');
});

test('90 complete UTC days exclude today and preserve downtime and missing records', () => {
  const records = daysFor({ dailyMinutesDown: { '2026-09-29': 84, '2026-09-28': 1440 } }, history, now);
  assert.equal(records.length, 90);
  assert.equal(records[0].date, '2026-07-02');
  assert.equal(records.at(-1).date, '2026-09-29');
  assert.equal(records.at(-1).state, 'partial');
  assert.equal(records.at(-2).state, 'down');
  assert.equal(records[0].minutes, 0);
  assert.ok(daysFor({}, history, now).every(d => d.state === 'unknown'));
  assert.ok(daysFor({ dailyMinutesDown: {} }, null, now).every(d => d.state === 'unknown'));
  const stale = daysFor({ dailyMinutesDown: {} }, { ...history, updated: now - 3 * day }, now);
  assert.equal(stale.at(-1).state, 'unknown');
  const started = daysFor({ dailyMinutesDown: {} }, { ...history, started: now - 10 * day }, now);
  assert.equal(started[0].state, 'unknown');
  assert.equal(started.at(-1).state, 'up');
  assert.equal(daysFor({ dailyMinutesDown: { '2026-09-29': -1 } }, history, now).at(-1).state, 'unknown');
});

test('malformed committed history does not produce an operational state', () => {
  assert.throws(() => parseHistory('status: up\n'));
  assert.throws(() => parseHistory('status: invalid\nlastUpdated: 2026-09-30\nstartTime: 2026-06-21\n'));
  assert.equal(history.response, 925);
});

test('fresh incident intervals merge overlaps and cover open outages across UTC midnight', () => {
  const { downtimeFor } = require('../assets/status.js');
  const issue = (number, start, end) => ({ number, labels: [{ name: 'api' }], created_at: start, closed_at: end });
  const records = [issue(1, '2026-09-28T23:00:00Z', '2026-09-29T01:00:00Z'), issue(2, '2026-09-29T00:30:00Z', '2026-09-29T02:00:00Z')];
  const map = downtimeFor('api', records, [], now).dailyMinutesDown;
  assert.equal(map['2026-09-28'], 60);
  assert.equal(map['2026-09-29'], 120);
  const open = issue(3, '2026-09-29T23:30:00Z', null);
  assert.equal(downtimeFor('api', records, [open], now).dailyMinutesDown['2026-09-29'], 150);
  assert.equal(downtimeFor('api', null, [], now), null);
  assert.equal(downtimeFor('api', [], null, now), null);
  assert.equal(downtimeFor('pages', records, [], now).dailyMinutesDown['2026-09-29'], 0);
});
