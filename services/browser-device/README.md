# Nalu browser companion

The browser runs on each user's own computer. See [the architecture and release
notes](../../docs/LOCAL_BROWSER.md) and the website's `/browser-setup.html`.

For normal Mac/Linux use, the published installer verifies and starts the bundled
Node companion. It requires Node.js 22+ and Chrome or Edge. Nalu Desktop 0.1.40
also bundles the same companion; choose Nalu → Browser connection. That Mac
package still requires Apple notarization before public distribution.

For isolated development with Docker:

```sh
sh services/browser-device/start.sh
```

Pair with the code displayed on the computer. Website logins remain in separate
account/agent profiles. The online AI receives observations and screenshots.
Take control stops inference before further input; Continue takes a fresh
observation. Additional agent tasks wait when local browser slots are occupied.

Validated on 2026-11-04: real Chromium typing/saving, frame observations,
screenshots, account/agent cookie isolation, HTTP origin/Host/pairing boundaries,
queued dispatch, keyboard chords, takeover during inference, and login handoff.
The live provider test typed/saved text and also read a code available only in
canvas pixels, entered it, saved it, and checked the real DOM result. The actual
HTTPS-origin-to-loopback-to-Chrome viewer connection passed with explicit
local-network permission. Tests use disposable profiles, not personal logins.

Source, signed Mac artifacts, installed apps and public releases require separate
verification. Check release receipts rather than treating this README as proof
that a particular domain or installed app has already updated.
