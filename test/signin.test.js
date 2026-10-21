/**
 * Sign-in: where the token is actually created, and where it could leak.
 *
 * poll() only reads the session. signIn() is the one place a token is
 * written, so that is where "never to disk" has to be proved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

function harness({ redirectResult, config = { supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: 'anon' } } = {}) {
  const stores = { session: {}, local: {} };
  const seen = { authUrl: null, interactive: null };
  const mk = (n) => ({
    get: async (k) => Object.fromEntries((Array.isArray(k) ? k : [k]).map((x) => [x, stores[n][x]])),
    set: async (o) => Object.assign(stores[n], o),
    remove: async (k) => (Array.isArray(k) ? k : [k]).forEach((x) => delete stores[n][x]),
  });
  globalThis.chrome = {
    storage: { session: mk('session'), local: mk('local') },
    identity: {
      getRedirectURL: () => 'https://abcdef.chromiumapp.org/',
      launchWebAuthFlow: async ({ url, interactive }) => {
        seen.authUrl = url; seen.interactive = interactive;
        if (redirectResult instanceof Error) throw redirectResult;
        return redirectResult;
      },
    },
    runtime: {}, alarms: {},
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => config });
  return { stores, seen };
}

const load = () => import(`../background.js?t=${Math.random()}`);

test('it asks Supabase, with its own redirect URL', async () => {
  const { seen } = harness({
    redirectResult: 'https://abcdef.chromiumapp.org/#access_token=TOK&expires_in=3600',
  });
  const w = await load();
  await w.signIn();
  assert.match(seen.authUrl, /^https:\/\/p\.supabase\.co\/auth\/v1\/authorize/);
  assert.match(seen.authUrl, /redirect_to=https%3A%2F%2Fabcdef\.chromiumapp\.org%2F/,
    'the redirect must be the extension\'s own, which Supabase has to allow-list');
  assert.equal(seen.interactive, true);
});

test('the token lands in session storage and NOWHERE else', async () => {
  /* session is memory-only and cleared when the browser closes. local
     persists to disk. A token in the wrong store outlives the browser and
     nothing about the extension looks different. */
  const { stores } = harness({
    redirectResult: 'https://abcdef.chromiumapp.org/#access_token=SECRET_TOK&expires_in=3600',
  });
  const w = await load();
  await w.signIn();
  assert.equal(stores.session['wl.session'].access_token, 'SECRET_TOK');
  assert.equal(JSON.stringify(stores.local).includes('SECRET_TOK'), false,
    'the persistent store must never contain the token');
});

test('a fresh sign-in starts with no inherited data', async () => {
  /* Otherwise the next account opens the popup and sees the previous one's
     traffic until the first poll lands. */
  const { stores } = harness({
    redirectResult: 'https://abcdef.chromiumapp.org/#access_token=T&expires_in=3600',
  });
  stores.local['wl.feed'] = [{ id: 'someone-elses' }];
  stores.local['wl.cursor'] = 'OLD';
  const w = await load();
  await w.signIn();
  assert.equal(stores.local['wl.feed'], undefined);
  assert.equal(stores.local['wl.cursor'], undefined);
});

test('an error in the redirect is reported, not swallowed', async () => {
  /* Supabase returns refusals in the fragment. "access_denied" has to reach
     the person, or sign-in just appears to do nothing. */
  harness({
    redirectResult: 'https://abcdef.chromiumapp.org/#error=access_denied&error_description=Not+allowed',
  });
  const w = await load();
  await assert.rejects(() => w.signIn(), /Not allowed/);
});

test('a cancelled window is an error, not a silent no-op', async () => {
  harness({ redirectResult: undefined });
  const w = await load();
  await assert.rejects(() => w.signIn(), /cancelled/);
});

test('a redirect with no token at all is refused', async () => {
  harness({ redirectResult: 'https://abcdef.chromiumapp.org/#state=xyz' });
  const w = await load();
  await assert.rejects(() => w.signIn(), /no token/);
});
