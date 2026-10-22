/**
 * A monitor must not be able to measure itself.
 *
 * wayleave.dev has been bitten by this shape twice. A gate metered the page's
 * own JavaScript and reported 83% suspected bot off its own scripts. A 404
 * page handed crawlers relative links, so every miss generated deeper misses
 * and the declared lane filled with traffic the site made against itself.
 *
 * This extension is the next place it would happen. It polls the Meter on a
 * schedule for as long as somebody leaves it installed. The Meter's control
 * plane is not gated today, so those polls record nothing — but "not gated
 * today" is a fact about a server, and the day it changes, the lane bars
 * start climbing with the popup open and nobody visiting anything. The number
 * would be real and its meaning false, which is worse than a wrong number.
 *
 * So the worker drops its own calls before they reach the feed, and these
 * tests fail if that stops being true.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isOwnTraffic, CLIENT_HEADER, CLIENT_ID } from '../api.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

const rc = (o = {}) => ({
  id: 'r1', occurred_at: '2026-10-21T10:00:00Z', lane: 'declared_agent',
  host: 'example.com', path: '/docs', status: 200, billed_usd: 0, ...o,
});

/* ── what counts as ours ───────────────────────────────────────────────── */

test('the extension\'s own account polls are recognised', () => {
  assert.equal(isOwnTraffic(rc({ host: 'meter.wayleave.dev', path: '/v1/account/receipts' })), true);
  assert.equal(isOwnTraffic(rc({ host: 'meter.wayleave.dev', path: '/v1/account/policy' })), true);
  assert.equal(isOwnTraffic(rc({ host: 'meter.wayleave.dev', path: '/v1/config' })), true);
});

test('a customer\'s real traffic is never mistaken for ours', () => {
  /* The failure that would matter most: silently hiding a paying customer's
     crossings because the filter was too broad. */
  assert.equal(isOwnTraffic(rc()), false);
  assert.equal(isOwnTraffic(rc({ host: 'meter.wayleave.dev', path: '/pricing' })), false);
  assert.equal(isOwnTraffic(rc({ host: 'api.wayleave.dev', path: '/v1/identify' })), false);
  assert.equal(isOwnTraffic(rc({ host: 'wayleave.dev', path: '/v1/account/receipts' })), false);
  assert.equal(isOwnTraffic(null), false);
  assert.equal(isOwnTraffic({}), false);
});

test('host matching is case-insensitive', () => {
  assert.equal(isOwnTraffic(rc({ host: 'Meter.Wayleave.Dev', path: '/v1/account/receipts' })), true);
});

/* ── and that the worker actually applies it ───────────────────────────── */

function fakeChrome(local = {}, session = { 'wl.session': { access_token: 'tok' } }) {
  const stores = { session: { ...session }, local: { ...local } };
  const mk = (n) => ({
    get: async (k) => Object.fromEntries((Array.isArray(k) ? k : [k]).map((x) => [x, stores[n][x]])),
    set: async (o) => Object.assign(stores[n], o),
    remove: async (k) => (Array.isArray(k) ? k : [k]).forEach((x) => delete stores[n][x]),
  });
  return { stores, api: { storage: { session: mk('session'), local: mk('local') }, runtime: {}, alarms: {}, identity: {} } };
}

test('own traffic never reaches the feed, or the disk', async () => {
  const { stores, api } = fakeChrome();
  globalThis.chrome = api;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      receipts: [
        rc({ id: 'mine', host: 'meter.wayleave.dev', path: '/v1/account/receipts' }),
        rc({ id: 'theirs', host: 'customer.example', path: '/api/listings' }),
      ],
      next_since: 'C1',
    }),
  });
  const w = await import(`../background.js?t=${Math.random()}`);
  const snap = await w.poll();

  assert.deepEqual(snap.receipts.map((r) => r.id), ['theirs'], 'only the real crossing');
  assert.equal(snap.selfDropped, 1, 'and it says so rather than hiding the drop');
  assert.equal(JSON.stringify(stores.local['wl.feed']).includes('mine'), false,
    'the cached feed on disk is clean too');
});

test('a feed of nothing but our own polls shows nothing, not a busy lane', async () => {
  /* The exact failure mode: popup left open, bars climbing, no visitors. */
  const { api } = fakeChrome();
  globalThis.chrome = api;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      receipts: Array.from({ length: 12 }, (_, i) =>
        rc({ id: 'p' + i, host: 'meter.wayleave.dev', path: '/v1/account/receipts' })),
      next_since: 'C1',
    }),
  });
  const w = await import(`../background.js?t=${Math.random()}`);
  const snap = await w.poll();
  assert.equal(snap.receipts.length, 0);
  assert.equal(snap.fresh, 0, 'twelve polls are not twelve crossings');
  assert.equal(snap.selfDropped, 12);
});

/* ── the marker ────────────────────────────────────────────────────────── */

test('every outbound request is attributable', () => {
  /* So an origin that does gate the control plane can exclude these by
     header, and so an access log says what they were. */
  const api = read('api.js');
  assert.match(api, /\[CLIENT_HEADER\]: CLIENT_ID/, 'the header is set on outbound calls');
  assert.equal((api.match(/\[CLIENT_HEADER\]: CLIENT_ID/g) || []).length, 2,
    'both /v1/config and the account calls carry it');
  assert.equal(CLIENT_HEADER, 'x-wayleave-client');
  assert.ok(CLIENT_ID.length > 0);
});

test('the filter runs in the worker, not only at render', () => {
  /* At render it would leave the cached rows on disk for a later version to
     read back as real. */
  const bg = read('background.js');
  assert.match(bg, /isOwnTraffic/, 'the worker imports and uses it');
  const popup = read('popup.js');
  assert.doesNotMatch(popup, /\.filter\(\s*\(?r\)?\s*=>\s*!isOwnTraffic/,
    'the popup does not re-filter; the worker owns it');
});
