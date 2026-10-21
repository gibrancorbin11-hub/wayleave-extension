# Wayleave Control Plane

A Chrome extension that puts your agent traffic in the toolbar: the lane split,
the live crossing feed, your route policy, and settlements — without opening the
dashboard.

It is the front end for [Wayleave](https://wayleave.dev), middleware that
identifies the AI agents reaching your site, decides what each one may do, and
charges them per request.

> **Not on the Chrome Web Store yet.** Install it from source with the four
> steps below. A store listing is a separate step and this README will say so
> when it exists.

## Install

1. Download this repository — **Code → Download ZIP**, then unzip it — or
   `git clone https://github.com/gibrancorbin11-hub/wayleave-extension.git`
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder.
4. Pin the Wayleave icon, click it, and sign in with your Wayleave account.

No account yet: [wayleave.dev](https://wayleave.dev).

## What it cannot do

This is a security product, so the interesting part is what the manifest does
**not** ask for. It requests three permissions — `storage`, `identity`,
`alarms` — and exactly one host, `meter.wayleave.dev`.

It has no `tabs`, `webRequest`, `webNavigation`, `history`, `scripting` or
`activeTab` permission, no content script on any page, and no `<all_urls>`
grant. It therefore cannot see what you browse. That is not a promise in a
privacy policy, it is the manifest, and `test/claims.test.js` fails the build
if any of it changes.

Two more properties worth knowing:

- **Your access token never touches the disk.** It lives in
  `chrome.storage.session`, which is memory-only and cleared when Chrome
  closes. `chrome.storage.local` holds the cached feed and nothing else, and a
  test asserts the token appears nowhere in it.
- **No remote code, no third-party requests.** The CSP is `script-src 'self'`,
  nothing is loaded off-origin, and no key or anon JWT is baked into the
  source — the Supabase config is fetched from `/v1/config` at runtime.

## Opening the dashboard

"Open dashboard" hands your session to wayleave.dev so you are not asked to
sign in twice. The token travels in the URL **fragment**, which is never sent
to a server and never appears in a `Referer` header, and the dashboard strips
it with `history.replaceState` the moment it lands.

## Development

```bash
npm test     # 27 tests, no dependencies, runs in plain Node
```

The logic is plain ES modules with `chrome.*` injected, so the service worker,
sign-in and the self-describing claims above are all testable outside a
browser. There is no build step: what is in this repository is what Chrome
loads.

## Licence

MIT.
