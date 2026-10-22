/**
 * The real Wayleave APIs, and what they will and will not do for an
 * extension.
 *
 * ── Why a session and not an API key ─────────────────────────────────────
 *
 * The Meter runs two authentication schemes that are deliberately not
 * interchangeable. An API key (`wm_live_`) reaches /v1/ledger and the
 * exports. A browser session reaches /v1/account/*, and an API key presented
 * there is refused in as many words: "an API key cannot manage account
 * settings — sign in instead."
 *
 * Everything this extension shows lives behind /v1/account/* — the receipts
 * feed, the policy document, the settlements. So it signs in; it does not
 * hold a key. That is also the safer side of the trade: a session expires on
 * its own, and a key pasted into an extension does not.
 *
 * ── The sign-in flow is Supabase's, not Wayleave's ───────────────────────
 *
 * The v1.0 prototype drew an OAuth consent screen with Wayleave-issued
 * scopes — telemetry:view, policies:configure, meter:monetize. Those do not
 * exist. The Meter has no authorization server (its only OAuth is as a
 * CLIENT, for Slack, Stripe and Vercel) and API keys carry no scopes at all.
 *
 * What does exist is Supabase auth, which the dashboard already uses, and
 * which supports exactly the flow the prototype drew: launchWebAuthFlow to
 * an authorize URL, tokens returned on the redirect. So the shape is kept
 * and the issuer is the real one. Scopes are not invented: this extension
 * can do precisely what the signed-in person can do in the dashboard, which
 * is the honest answer until the Meter grows a scope model.
 */

export const METER = 'https://meter.wayleave.dev';

/**
 * Every request this extension makes carries this header.
 *
 * A monitor that can be counted by the thing it monitors reports its own
 * heartbeat as traffic, and the number climbs on its own with nothing behind
 * it. wayleave.dev has now been bitten by that shape twice: a gate metering
 * the page's own JavaScript, and a 404 page handing crawlers relative links
 * that generated an unbounded tree of self-inflicted misses.
 *
 * The Meter's control-plane API is not behind a gate today, so these polls
 * record nothing. "Not gated today" is not a property anyone should have to
 * re-verify, so the requests are marked at the source: an origin that ever
 * does gate /v1/account/* can drop them by this header instead of counting
 * them, and anyone reading an access log can see what they were.
 *
 * isOwnTraffic() below is the second half, and the half that does not depend
 * on the server doing the right thing.
 */
export const CLIENT_HEADER = 'x-wayleave-client';
export const CLIENT_ID = 'control-plane-extension';

/**
 * Is this receipt one of our own calls?
 *
 * Displaying it would be a lie of exactly the kind this product exists to
 * stop: a lane bar that rises because the panel is open, not because anybody
 * crossed anything. Checked on the client because the client is the only
 * party that knows for certain which requests it made.
 */
export function isOwnTraffic(receipt) {
  if (!receipt) return false;
  const host = String(receipt.host || '').toLowerCase();
  const path = String(receipt.path || '');
  if (String(receipt.client || receipt.identity || '').includes(CLIENT_ID)) return true;
  // the Meter's own control plane, which is the only thing this extension calls
  return host === 'meter.wayleave.dev' && (path.startsWith('/v1/account') || path === '/v1/config');
}

/** Supabase project, as the Meter itself publishes it. Never a secret. */
export async function discoverAuth() {
  const r = await fetch(`${METER}/v1/config`, {
    headers: { accept: 'application/json', [CLIENT_HEADER]: CLIENT_ID },
  });
  if (!r.ok) throw new Error(`sign-in is unavailable (config ${r.status})`);
  const c = await r.json();
  if (!c.supabaseUrl || !c.supabaseAnonKey)
    throw new Error('sign-in is not configured on the Meter');
  return c;
}

/**
 * One authenticated call to the account API.
 *
 * A 401 is not retried and not swallowed: it means the session is finished,
 * and the caller has to put the person back through sign-in rather than
 * showing stale numbers behind a spinner that never resolves.
 */
export async function account(path, token, init = {}) {
  const res = await fetch(`${METER}/v1/account${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      [CLIENT_HEADER]: CLIENT_ID,
      ...(init.headers || {}),
    },
  });
  if (res.status === 401) { const e = new Error('session expired'); e.expired = true; throw e; }
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

/**
 * Receipts, forward from a cursor.
 *
 * `since` walks OLDEST FIRST, which is the only way to poll without gaps: if
 * more crossings arrive between polls than the limit allows, newest-first
 * would hand back the newest N and leave the middle unseen for ever. Walking
 * forward the view lags when traffic is heavy rather than silently losing
 * rows, and lag is something you can see.
 *
 * Returns the rows plus the cursor to use next. The cursor is the server's;
 * building one locally out of a timestamp reintroduces the tie bug it exists
 * to avoid, because many receipts share a timestamp.
 */
export async function receiptsSince(token, cursor, limit = 100) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set('since', cursor);
  const d = await account(`/receipts?${q}`, token);
  return { receipts: d.receipts || [], cursor: d.next_since || cursor || null };
}

/** The newest page, for a cold start. Newest first. */
export async function receiptsLatest(token, limit = 100) {
  const d = await account(`/receipts?limit=${limit}`, token);
  return { receipts: d.receipts || [], cursor: d.next_since || null };
}

export const getPolicy = (token) => account('/policy', token);

export const putPolicy = (token, policy) =>
  account('/policy', token, { method: 'PUT', body: JSON.stringify(policy) });

export const getSettlements = (token) => account('/settlements?limit=50', token);
