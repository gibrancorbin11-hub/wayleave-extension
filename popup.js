/**
 * The popup. Renders what the worker has; never fetches.
 *
 * A popup is destroyed the moment it loses focus, so a request started here
 * would be abandoned mid-flight with the polling cursor half-advanced. The
 * worker owns the token and the polling; this asks for a snapshot.
 */
import { account, getPolicy, getSettlements } from './api.js';

const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg);

/**
 * The lanes this system actually has.
 *
 * The v1.0 prototype showed "Lane 1 Human verified / Lane 2 Disclosed AI
 * agent / Lane 3 Suspected bot / Lane 4 Blocked signature". Three of those
 * map onto something real and the fourth does not: "blocked signature" is a
 * STATUS, not a lane, and the lane it displaced — verified_agent — is the
 * only one Wayleave can prove cryptographically and the one the product is
 * sold on. Showing the invented lane and hiding the real one would have been
 * a redesign of the product, not a skin.
 *
 * `human` is labelled "Unclassified" rather than "Human". The lane is a
 * fall-through: it is reached by tripping none of the automation tells, which
 * is absence of evidence and not evidence of a person. A bot that sends a
 * browser user-agent and an accept-language header lands here, and the README
 * says so. Calling it "Human" asserts something no check established, which is
 * the one thing this vocabulary is built to avoid.
 *
 * `unknown` is deliberately absent, as it is on the dashboard: it is this
 * system failing to classify, not a kind of visitor, and giving it a lane
 * bar would invite somebody to write policy against it.
 */
const LANES = [
  { key: 'human',           label: 'Unclassified',   css: 'var(--human)' },
  { key: 'verified_agent',  label: 'Verified agent', css: 'var(--verified)' },
  { key: 'declared_agent',  label: 'Declared agent', css: 'var(--declared)' },
  { key: 'suspected_bot',   label: 'Suspected bot',  css: 'var(--suspect)' },
];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const clock = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(+d) ? '--:--:--' : d.toTimeString().slice(0, 8);
};

function show(which) {
  $('connect').hidden = which !== 'out';
  $('console').hidden = which !== 'in';
  $('signOut').hidden = which !== 'in';
}

function fail(message) {
  const el = $('error');
  el.hidden = !message;
  el.textContent = message || '';
}

/* ── telemetry ─────────────────────────────────────────────────────────── */

function renderLanes(receipts) {
  const total = receipts.length;
  $('reqCount').textContent = total;

  const counted = LANES.map((l) => ({
    ...l, n: receipts.filter((r) => r.lane === l.key).length,
  }));

  $('lanes').innerHTML = counted.map((l) => {
    /* Percentages are of what this feed holds, which is a window and not the
       account's lifetime. Said in the note under the feed rather than left
       for somebody to assume. */
    const pct = total ? Math.round((l.n / total) * 100) : 0;
    return `<li>
      <span class="swatch" style="background:${l.css}"></span>
      <span>${esc(l.label)}</span>
      <span class="track"><span class="fill" style="width:${pct}%;background:${l.css}"></span></span>
      <span class="pct">${pct}%</span>
    </li>`;
  }).join('');
}

function renderFeed(receipts) {
  const rows = receipts.slice(0, 40);
  $('feed').innerHTML = rows.length ? rows.map((r) => {
    /* What actually happened, from the status the gate recorded. 402 is not
       a failure here — it is the product working. */
    const cls = r.status === 200 ? (Number(r.billed_usd) > 0 ? 'paid' : 'ok')
              : r.status === 402 ? 'paid' : 'deny';
    const verdict = r.status === 200 ? (Number(r.billed_usd) > 0 ? `$${r.billed_usd}` : 'pass')
                  : String(r.status);
    return `<li>
      <span class="t">${clock(r.occurred_at)}</span>
      <span class="what">${esc(r.identity || r.lane)} → ${esc(r.path || '/')}</span>
      <span class="verdict ${cls}">${esc(verdict)}</span>
    </li>`;
  }).join('') : '<li class="muted">No crossings recorded yet.</li>';

  $('feedNote').textContent = receipts.length
    ? `Last ${rows.length} of ${receipts.length} held locally. Percentages are of this window, not all time.`
    : '';
}

/* ── the other two tabs, loaded on demand ─────────────────────────────── */

async function loadPolicy(token) {
  try {
    const p = await getPolicy(token);
    $('policyVer').textContent = p.version ? `policy v${p.version}` : 'policy —';
    const rules = p.rules || p.policy?.rules || null;
    $('policySummary').textContent = rules
      ? `${Array.isArray(rules) ? rules.length : Object.keys(rules).length} rule(s) in force.`
      : 'No route rules set. Every lane is allowed.';
    $('policyDoc').textContent = JSON.stringify(p, null, 2);
  } catch (e) {
    $('policySummary').textContent = `Could not read policy: ${e.message}`;
  }
}

async function loadSettlements(token) {
  try {
    const d = await getSettlements(token);
    const rows = d.settlements || [];
    $('settlements').innerHTML = rows.length ? rows.map((s) => `<li>
        <span class="t">${clock(s.settled_at || s.created_at)}</span>
        <span class="what">${esc(s.facilitator_ref || s.id || '')}</span>
        <span class="verdict paid">$${esc(s.amount_usd ?? '0.00')}</span>
      </li>`).join('')
      : '<li class="muted">No settlements yet.</li>';
    $('meterNote').textContent = rows.length
      ? '' : 'A settlement appears once an agent pays a 402 and the rail confirms it.';
  } catch (e) {
    $('meterNote').textContent = `Could not read settlements: ${e.message}`;
  }
}

/* ── wiring ────────────────────────────────────────────────────────────── */

document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.panel').forEach((p) => {
      p.hidden = p.dataset.panel !== b.dataset.tab;
    });
  });
});

$('signIn').addEventListener('click', async () => {
  fail('');
  $('signIn').disabled = true;
  $('signIn').textContent = 'Opening…';
  const r = await ask({ type: 'signIn' });
  $('signIn').disabled = false;
  $('signIn').textContent = 'Sign in with Wayleave';
  if (r?.error) return fail(r.error);
  paint(r);
});

/**
 * Open the dashboard already signed in.
 *
 * The extension and the website hold separate sessions — one in
 * chrome.storage.session, one in wayleave.dev's own storage — so a plain
 * link lands on a sign-in page for somebody who just signed in here.
 *
 * The session is handed over in the URL FRAGMENT, which is the same
 * mechanism Supabase's own OAuth return already uses: wl-auth.js reads
 * access_token / refresh_token / expires_in out of the hash and then calls
 * history.replaceState to strip it, so the token never reaches the address
 * bar for more than an instant and never appears in history. A fragment is
 * also never sent to the server and never travels in a Referer header.
 *
 * Signed out, or missing a token, it opens the plain dashboard rather than
 * a URL with an empty fragment that would look like a broken hand-off.
 */
async function openDashboard() {
  const base = 'https://wayleave.dev/app';
  let url = base;
  try {
    const { 'wl.session': s } = await chrome.storage.session.get('wl.session');
    if (s?.access_token) {
      const q = new URLSearchParams({ access_token: s.access_token });
      if (s.refresh_token) q.set('refresh_token', s.refresh_token);
      // seconds remaining, floored at 60 so the dashboard is never handed
      // something already expired
      const left = Math.max(60, Math.round(((s.expires_at || 0) - Date.now()) / 1000));
      q.set('expires_in', String(left));
      url = `${base}#${q}`;
    }
  } catch { /* fall through to the plain dashboard */ }
  chrome.tabs.create({ url });
}

$('openDash').addEventListener('click', (e) => { e.preventDefault(); openDashboard(); });

$('signOut').addEventListener('click', async () => { paint(await ask({ type: 'signOut' })); });

function paint(snap) {
  if (!snap || snap.error) { show('out'); return fail(snap?.error || 'no answer from the extension'); }
  if (!snap.signedIn) { show('out'); return fail(snap.reason || ''); }

  show('in');
  fail(snap.error || '');
  const receipts = snap.receipts || [];
  renderLanes(receipts);
  renderFeed(receipts);
  $('lastSync').textContent = snap.error
    ? 'Last sync failed'
    : `Synced ${new Date().toTimeString().slice(0, 5)}${snap.fresh ? ` · ${snap.fresh} new` : ''}`;
  document.querySelector('.status').classList.toggle('stale', Boolean(snap.error));

  chrome.storage.session.get('wl.session').then(({ 'wl.session': s }) => {
    if (!s) return;
    loadPolicy(s.access_token);
    loadSettlements(s.access_token);
    account('', s.access_token)
      .then((a) => { $('account').textContent = `· ${a.email || ''}`; })
      .catch(() => {});
  });
}

paint(await ask({ type: 'snapshot' }));
