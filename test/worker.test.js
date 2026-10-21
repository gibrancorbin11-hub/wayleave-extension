/**
 * The service worker: the three things that break quietly.
 *
 *   The feed is merged from two sources that arrive in OPPOSITE orders — a
 *   cold page is newest-first, a cursor page is oldest-first. Get it wrong
 *   and the activity list scrolls backwards, but only once traffic is live,
 *   which is a long way from where the mistake is.
 *
 *   The token must never reach chrome.storage.local. local persists to disk;
 *   session does not. An access token written to the wrong store outlives
 *   the browser, and nothing about the extension looks different.
 *
 *   A 401 must end the session rather than be retried. The alternative is a
 *   popup showing yesterday's numbers behind a spinner that never resolves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/* A chrome.* double that records which STORE each key went to, because that
   distinction is the security property. */
function fakeChrome({ session = {}, local = {} } = {}) {
  const stores = { session: { ...session }, local: { ...local } };
  const mk = (name) => ({
    get: async (k) => {
      const keys = Array.isArray(k) ? k : [k];
      return Object.fromEntries(keys.map((x) => [x, stores[name][x]]));
    },
    set: async (o) => Object.assign(stores[name], o),
    remove: async (k) => (Array.isArray(k) ? k : [k]).forEach((x) => delete stores[name][x]),
  });
  return {
    stores,
    api: {
      storage: { session: mk('session'), local: mk('local') },
      runtime: {}, alarms: {}, identity: {},
    },
  };
}

const receipt = (i, at) => ({ id: `r${i}`, occurred_at: at, lane: 'declared_agent',
                              path: '/x', identity: 'bot', status: 200, billed_usd: 0 });

/** Import background.js fresh, with chrome and fetch stubbed. */
async function loadWorker({ chrome: c, fetchImpl }) {
  globalThis.chrome = c;
  globalThis.fetch = fetchImpl;
  // cache-bust so each test gets its own module instance
  return import(`../background.js?t=${Math.random()}`);
}

const jsonOnce = (payload, status = 200) => async () => ({
  ok: status < 400, status, json: async () => payload,
});

test('a cold start takes the newest page and keeps it newest-first', async () => {
  const { stores, api } = fakeChrome({ session: { 'wl.session': { access_token: 'tok' } } });
  const w = await loadWorker({
    chrome: api,
    fetchImpl: jsonOnce({ receipts: [receipt(1, '2026-10-20T10:00:02Z'),
                                     receipt(2, '2026-10-20T10:00:01Z')],
                          next_since: 'CUR1' }),
  });
  const snap = await w.poll();
  assert.equal(snap.signedIn, true);
  assert.deepEqual(snap.receipts.map((r) => r.id), ['r1', 'r2'], 'newest first');
  assert.equal(stores.local['wl.cursor'], 'CUR1', 'the cursor is advanced and kept');
});

test('a cursor page arrives oldest-first and is REVERSED onto the front', async () => {
  /* The one that only shows up once traffic is live. `since` returns
     ascending so the client cannot skip rows; the feed is newest-first; so
     the incoming page has to be flipped before it goes on top. */
  const { api } = fakeChrome({
    session: { 'wl.session': { access_token: 'tok' } },
    local: { 'wl.cursor': 'CUR1', 'wl.feed': [receipt(1, '2026-10-20T10:00:02Z')] },
  });
  const w = await loadWorker({
    chrome: api,
    // oldest first, as /receipts?since= returns
    fetchImpl: jsonOnce({ receipts: [receipt(2, '2026-10-20T10:00:03Z'),
                                     receipt(3, '2026-10-20T10:00:04Z')],
                          next_since: 'CUR2' }),
  });
  const snap = await w.poll();
  assert.deepEqual(snap.receipts.map((r) => r.id), ['r3', 'r2', 'r1'],
    'newest of the new page first, then the rest, then what was already held');
  assert.equal(snap.fresh, 2);
});

test('the held feed is capped, so it cannot grow without bound', async () => {
  const existing = Array.from({ length: 200 }, (_, i) => receipt(i, '2026-10-20T09:00:00Z'));
  const { stores, api } = fakeChrome({
    session: { 'wl.session': { access_token: 'tok' } },
    local: { 'wl.cursor': 'CUR1', 'wl.feed': existing },
  });
  const w = await loadWorker({
    chrome: api,
    fetchImpl: jsonOnce({ receipts: [receipt(999, '2026-10-20T10:00:00Z')], next_since: 'CUR2' }),
  });
  const snap = await w.poll();
  assert.equal(snap.receipts.length, 200, 'still 200, not 201');
  assert.equal(snap.receipts[0].id, 'r999', 'the new row is kept');
  assert.equal(stores.local['wl.feed'].length, 200);
});

test('a 401 ends the session instead of showing stale numbers', async () => {
  const { stores, api } = fakeChrome({
    session: { 'wl.session': { access_token: 'stale' } },
    local: { 'wl.cursor': 'CUR1', 'wl.feed': [receipt(1, '2026-10-20T10:00:00Z')] },
  });
  const w = await loadWorker({ chrome: api, fetchImpl: jsonOnce({}, 401) });
  const snap = await w.poll();
  assert.equal(snap.signedIn, false);
  assert.match(snap.reason, /expired/);
  assert.equal(stores.session['wl.session'], undefined, 'token gone');
  assert.equal(stores.local['wl.feed'], undefined, 'and so is the data it fetched');
});

test('a transient failure keeps the session and shows what it already had', async () => {
  /* Distinct from a 401. A network blip must not sign somebody out. */
  const { stores, api } = fakeChrome({
    session: { 'wl.session': { access_token: 'tok' } },
    local: { 'wl.cursor': 'CUR1', 'wl.feed': [receipt(1, '2026-10-20T10:00:00Z')] },
  });
  const w = await loadWorker({
    chrome: api,
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  const snap = await w.poll();
  assert.equal(snap.signedIn, true, 'still signed in');
  assert.equal(snap.receipts.length, 1, 'shows what it held');
  assert.match(snap.error, /ECONNRESET/);
  assert.ok(stores.session['wl.session'], 'the token survives a blip');
});

test('signed out, it reports so rather than calling the API', async () => {
  let called = 0;
  const { api } = fakeChrome();
  const w = await loadWorker({ chrome: api, fetchImpl: async () => { called++; return jsonOnce({})(); } });
  assert.deepEqual(await w.poll(), { signedIn: false });
  assert.equal(called, 0, 'no unauthenticated request is made');
});

test('the token is never written to storage.local', async () => {
  /* local persists to disk; session does not. This is the whole reason the
     two stores are used differently, and nothing about a token in the wrong
     one looks wrong from the outside. */
  const { stores, api } = fakeChrome({ session: { 'wl.session': { access_token: 'tok' } } });
  const w = await loadWorker({
    chrome: api,
    fetchImpl: jsonOnce({ receipts: [receipt(1, '2026-10-20T10:00:00Z')], next_since: 'C' }),
  });
  await w.poll();
  assert.equal(JSON.stringify(stores.local).includes('tok'), false,
    'no access token anywhere in the persistent store');
});

test('signing out clears the data as well as the token', async () => {
  const { stores, api } = fakeChrome({
    session: { 'wl.session': { access_token: 'tok' } },
    local: { 'wl.cursor': 'C', 'wl.feed': [receipt(1, '2026-10-20T10:00:00Z')] },
  });
  const w = await loadWorker({ chrome: api, fetchImpl: jsonOnce({}) });
  await w.signOut();
  assert.deepEqual(stores.session, {});
  assert.deepEqual(stores.local, {}, 'another account must not inherit the last one\'s feed');
});

/* ── the dashboard hand-off ─────────────────────────────────────────────
   Clicking "Open dashboard" must not land on a sign-in page for somebody
   who signed in to the extension a second ago. The two hold separate
   sessions, so the token travels in the URL fragment — the same mechanism
   Supabase's own OAuth return uses, and the one wl-auth.js already reads. */

test('a refresh token is kept, because the dashboard needs it', async () => {
  /* Without one the handed-over session cannot renew and dies at expiry:
     signed in for an hour, then silently signed out mid-session. */
  const stores = { session: {}, local: {} };
  const mk = (n) => ({
    get: async (k) => Object.fromEntries((Array.isArray(k) ? k : [k]).map((x) => [x, stores[n][x]])),
    set: async (o) => Object.assign(stores[n], o),
    remove: async (k) => (Array.isArray(k) ? k : [k]).forEach((x) => delete stores[n][x]),
  });
  globalThis.chrome = {
    storage: { session: mk('session'), local: mk('local') },
    identity: {
      getRedirectURL: () => 'https://x.chromiumapp.org/',
      launchWebAuthFlow: async () =>
        'https://x.chromiumapp.org/#access_token=AT&refresh_token=RT&expires_in=3600',
    },
    runtime: {}, alarms: {},
  };
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: 'anon' }),
  });

  const w = await import(`../background.js?t=${Math.random()}`);
  await w.signIn();
  const s = stores.session['wl.session'];
  assert.equal(s.access_token, 'AT');
  assert.equal(s.refresh_token, 'RT', 'kept for the hand-off');
  assert.ok(s.expires_at > Date.now(), 'and an expiry the hand-off can compute from');
});

test('a sign-in with no refresh token still works', async () => {
  /* Some flows do not return one. Storing undefined would be fine; what
     must not happen is signIn() failing over it. */
  const stores = { session: {}, local: {} };
  const mk = (n) => ({
    get: async (k) => Object.fromEntries((Array.isArray(k) ? k : [k]).map((x) => [x, stores[n][x]])),
    set: async (o) => Object.assign(stores[n], o),
    remove: async (k) => (Array.isArray(k) ? k : [k]).forEach((x) => delete stores[n][x]),
  });
  globalThis.chrome = {
    storage: { session: mk('session'), local: mk('local') },
    identity: {
      getRedirectURL: () => 'https://x.chromiumapp.org/',
      launchWebAuthFlow: async () => 'https://x.chromiumapp.org/#access_token=AT&expires_in=3600',
    },
    runtime: {}, alarms: {},
  };
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: 'anon' }),
  });
  const w = await import(`../background.js?t=${Math.random()}`);
  await w.signIn();
  assert.equal(stores.session['wl.session'].access_token, 'AT');
  assert.equal(stores.session['wl.session'].refresh_token, null);
});
