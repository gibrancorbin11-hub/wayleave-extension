/**
 * The service worker: sign-in, and the only place a token is kept.
 *
 * ── MV3 kills this worker, and that is the design, not a fault ───────────
 *
 * Chrome evicts an idle service worker after roughly thirty seconds. Every
 * variable in this file disappears with it. So nothing that must survive is
 * held in a variable — the session goes to chrome.storage.session, which is
 * cleared when the browser closes and is never written to disk, and the
 * polling cursor goes to chrome.storage.local so a reopened popup resumes
 * where it stopped instead of refetching a page it has already shown.
 *
 * The v1.0 prototype modelled this exactly, with an "Evict worker" button.
 * It was right to: an extension that keeps its session in a module-level
 * variable works perfectly until the worker sleeps, and then signs the
 * person out for no reason they can see.
 *
 * ── Why the popup does not fetch ─────────────────────────────────────────
 *
 * A popup is destroyed the moment it loses focus, which would abandon any
 * request in flight and leave the cursor half-advanced. The worker owns the
 * token and the polling; the popup asks it for a snapshot and renders.
 */
import { discoverAuth, receiptsSince, receiptsLatest } from './api.js';

const SESSION = 'wl.session';      // chrome.storage.session — token, memory only
const CURSOR = 'wl.cursor';        // chrome.storage.local  — where polling got to
const FEED = 'wl.feed';            // chrome.storage.local  — last rows, for a cold popup

const readSession = async () => (await chrome.storage.session.get(SESSION))[SESSION] || null;
const writeSession = (s) => chrome.storage.session.set({ [SESSION]: s });

/**
 * Sign in through Supabase, in a browser-managed window.
 *
 * launchWebAuthFlow opens a window the extension cannot read — it only
 * receives the final redirect. The tokens come back in the URL fragment,
 * which never reaches a server, and are moved straight into session storage.
 *
 * The redirect URL is chrome.identity.getRedirectURL(), which is
 * https://<extension-id>.chromiumapp.org/. Supabase will refuse to redirect
 * anywhere not on its allow-list, so that exact URL has to be added there —
 * a deliberate gate, and the reason sign-in fails loudly rather than
 * silently sending somebody's tokens to a host nobody vetted.
 */
async function signIn() {
  const cfg = await discoverAuth();
  const redirect = chrome.identity.getRedirectURL();
  const url = `${cfg.supabaseUrl}/auth/v1/authorize`
    + `?provider=google&redirect_to=${encodeURIComponent(redirect)}`;

  const final = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  if (!final) throw new Error('sign-in was cancelled');

  const frag = new URL(final).hash.replace(/^#/, '');
  const p = new URLSearchParams(frag);
  const access_token = p.get('access_token');
  if (!access_token) {
    const err = p.get('error_description') || p.get('error') || 'no token in the redirect';
    throw new Error(decodeURIComponent(err).replace(/\+/g, ' '));
  }

  const session = {
    access_token,
    expires_at: Date.now() + (Number(p.get('expires_in') || 3600) * 1000),
  };
  await writeSession(session);
  await chrome.storage.local.remove([CURSOR, FEED]);  // a new session starts clean
  return session;
}

async function signOut() {
  await chrome.storage.session.remove(SESSION);
  await chrome.storage.local.remove([CURSOR, FEED]);
}

/**
 * Advance the feed.
 *
 * Cold start takes the newest page; afterwards it walks forward from the
 * cursor so nothing is missed. Rows are capped at 200 in storage — a popup
 * shows a window, and an unbounded local log is a slow leak nobody notices.
 */
async function poll() {
  const session = await readSession();
  if (!session) return { signedIn: false };

  const { [CURSOR]: cursor } = await chrome.storage.local.get(CURSOR);
  const { [FEED]: feed = [] } = await chrome.storage.local.get(FEED);

  try {
    const got = cursor
      ? await receiptsSince(session.access_token, cursor)
      : await receiptsLatest(session.access_token);

    /* `since` returns oldest-first and the cold page newest-first. The feed
       is kept newest-first, so forward pages are reversed before they go on
       the front. Getting this backwards shows a feed that scrolls the wrong
       way only once traffic is live, which is a hard thing to notice. */
    const incoming = cursor ? got.receipts.slice().reverse() : got.receipts;
    const merged = [...incoming, ...feed].slice(0, 200);

    await chrome.storage.local.set({ [FEED]: merged, [CURSOR]: got.cursor });
    return { signedIn: true, receipts: merged, fresh: incoming.length };
  } catch (e) {
    if (e.expired) { await signOut(); return { signedIn: false, reason: 'session expired' }; }
    return { signedIn: true, receipts: feed, error: String(e.message || e) };
  }
}

/* Polling continues while the popup is shut, so opening it shows current
   numbers rather than a spinner. An alarm rather than setInterval, because
   setInterval dies with the worker and an alarm wakes it. */
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('wl.poll', { periodInMinutes: 1 });
});
chrome.alarms?.onAlarm.addListener((a) => { if (a.name === 'wl.poll') poll(); });

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    try {
      if (msg.type === 'signIn') { await signIn(); reply(await poll()); return; }
      if (msg.type === 'signOut') { await signOut(); reply({ signedIn: false }); return; }
      if (msg.type === 'snapshot') { reply(await poll()); return; }
      reply({ error: `unknown message: ${msg.type}` });
    } catch (e) {
      reply({ error: String(e.message || e) });
    }
  })();
  return true;   // the reply is async; without this the channel closes first
});
