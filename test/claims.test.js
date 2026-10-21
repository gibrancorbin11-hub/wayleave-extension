/**
 * The claims this extension makes about itself.
 *
 * "The extension never reads your browsing" is printed in the popup. It is
 * true because of what the manifest does NOT ask for, and that is a property
 * one convenient feature can quietly end. Same for the lane list: it is the
 * product's own vocabulary, and the v1.0 prototype got it wrong in a way
 * that would have been easy to copy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

test('it cannot read your browsing, and that is enforced by the manifest', () => {
  /* The popup says so in as many words. These are the permissions that
     would make it false. */
  const perms = manifest.permissions || [];
  const hosts = manifest.host_permissions || [];
  for (const forbidden of ['tabs', 'webRequest', 'webNavigation', 'history', 'scripting', 'activeTab'])
    assert.ok(!perms.includes(forbidden), `${forbidden} would let it watch browsing`);
  assert.deepEqual(manifest.content_scripts, undefined, 'no content script runs on any page');
  for (const h of hosts)
    assert.ok(!/\*:\/\/\*|<all_urls>/.test(h), `${h} is access to every site`);
});

test('it reaches exactly one host', () => {
  assert.deepEqual(manifest.host_permissions, ['https://meter.wayleave.dev/*']);
});

test('the permissions it does ask for are the ones it uses', () => {
  /* An unused permission is a thing a reviewer has to ask about and a thing
     a future reader assumes is load-bearing. */
  const src = read('background.js') + read('popup.js') + read('api.js');
  for (const p of manifest.permissions) {
    const used = { storage: /chrome\.storage/, identity: /chrome\.identity/, alarms: /chrome\.alarms/ }[p];
    assert.ok(used, `no rule for permission "${p}"`);
    assert.match(src, used, `"${p}" is requested but never used`);
  }
});

test('the content security policy admits no remote code', () => {
  const csp = manifest.content_security_policy?.extension_pages || '';
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline|https:/);
});

test('nothing is loaded from off-origin', () => {
  /* The prototype pulled fonts from Google. In an extension that is a
     third party watching every popup open. */
  const html = read('popup.html');
  assert.doesNotMatch(html, /https?:\/\/(?!wayleave\.dev)/,
    'the only external link may be the dashboard');
});

test('the lanes are the product\'s, not the prototype\'s', () => {
  /* The v1.0 prototype showed "Lane 4 · Blocked signature" and omitted
     verified_agent. Blocked-signature is a STATUS. verified_agent is the
     only lane Wayleave can prove, and the one the product is sold on. */
  /* Read the LANES array, not the file. The file explains in a comment why
     the prototype's "Blocked signature" is wrong, and a whole-file match
     fails on that explanation — the comment is the reason the mistake will
     not be repeated, so the test has to be narrower than the prose. */
  const src = read('popup.js');
  const block = src.slice(src.indexOf('const LANES'), src.indexOf('];', src.indexOf('const LANES')));
  const keys = [...block.matchAll(/key: '([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['human', 'verified_agent', 'declared_agent', 'suspected_bot']);
});

test('`unknown` is not given a lane bar', () => {
  /* It is this system failing to classify, not a kind of visitor. A bar
     invites somebody to write policy against it. */
  const src = read('popup.js');
  const block = src.slice(src.indexOf('const LANES'), src.indexOf('];', src.indexOf('const LANES')));
  assert.doesNotMatch(block, /'unknown'/);
});

test('no credential is hardcoded anywhere', () => {
  const src = read('background.js') + read('popup.js') + read('api.js') + read('manifest.json');
  assert.doesNotMatch(src, /wm_live_[A-Za-z0-9]|wk_live_[A-Za-z0-9]|eyJhbGciOi/,
    'no key, no anon JWT — the anon key is fetched from /v1/config at runtime');
});

test('the popup never fetches', () => {
  /* A popup is destroyed on blur. A request started there is abandoned
     mid-flight with the cursor half-advanced, which silently loses rows.
     The worker owns the network. */
  const popup = read('popup.js');
  assert.doesNotMatch(popup, /\bfetch\s*\(/, 'popup.js must not call fetch directly');
});
