# Browser on each user's computer

The Browser workspace and `browser_work` / `browser_status` tools connect to a
local companion at `http://127.0.0.1:8877/device`. Chromium runs on that computer;
there is no cloud browser pool or public tunnel. The same companion is bundled
into Nalu Desktop and available through `/browser-setup.html` as a Node launcher.

## Ownership and connection

The companion accepts only the four public Nalu origins and the exact loopback
Host. Pairing requires a random code shown on the computer and a Nalu token
verified through `/api/auth`. A random device capability is also required for
subsequent requests. It stays in webpage memory and is never synced or sent to
the model. Re-pairing stops the old account's work and invalidates its capability.
Account changes cannot use an earlier connection.

The profile path hashes `[verified account ID, agent ID]`. Every agent has an
independent Chromium process/profile and virtual input. Browser cookies and
storage stay on the device. Login state may expire or need human verification.
No existing Chrome profiles are copied. The browser has no filesystem, terminal,
IDE or OS-control API, and its outbound proxy blocks private network addresses.

Up to 1,000 logical agent records can exist. Two browser processes run at once by
default, bounded at four by configuration. Additional tasks queue until a slot
is freed; close an idle browser to release a slot. Thousands of simultaneous
browser processes on one ordinary computer are not promised. Tabs share their
agent's profile; different agents do not share profiles.

## AI and human interaction

The agent observes visible elements across frames plus a screenshot. Actions are
validated navigation, element clicks/typing, coordinate clicks/drags, keyboard
shortcuts, scrolling and tab changes. Model output never becomes JavaScript or
shell code. Page content is untrusted. Actions serialize within each browser;
takeover invalidates inference and waits for active input to finish. Password
and OTP fields request human help before inference. Continue uses a fresh page
observation and can include a user clarification.

The current agent uses Nalu's online model providers. Observations and screenshots
leave the device for inference; cookies and profile files do not. On-device-only
AI settings block agent start/resume instead of silently using online models.
The user can explicitly select “Allow online AI for browser tasks” in the Browser
panel. That exception is scoped to the current account connection in tab memory,
resets on re-pairing, and does not change other AI preferences.
Manual viewing and control remain available. Both the browser and the companion
must stay running. An idle connection expires after fifteen minutes without a
website request; closing/restarting the companion stops its in-memory tasks.

Provider outages and malformed actions yield help/errors, never success. The
viewer labels completion as the agent's report. A live test separately checks the
actual saved DOM state, including text read exclusively from an image-only canvas.
Real Word/Excel accounts, MFA providers, reservation systems and email services
can impose their own login/automation requirements. There is no claim of universal
website compatibility or verified completion in every third-party app.

## Build, release and verification

`services/browser-device` owns the runtime. `build-native.mjs` bundles it without
credentials. Desktop's `scripts/build-browser-device.mjs` includes the bundle in
its build. `naludesktop/cli/browser-device-install.sh` owns the direct installer;
run the CLI tests, then its `cli/publish.sh` to publish the bundle, installer and
SHA-256 checksum into `train/client/public`. Never hand-edit release copies.

Web publication must use the approved design checkout and checked `deploy.sh`.
Verify all four public domains, the setup/installer assets and the live AI path.
Mac installers require their own signing, runtime and Apple notarization checks;
a locally signed build is not a notarized public release.

Relevant checks: `browser-decision-regressions.mjs`, `browser-workspace-ui.mjs`,
`browser-device-connection-ui.mjs`, `browser-device-live-native.mjs`,
`browser-device-desktop-test.mjs`, and the companion's `integration.mjs`.
The existing `/api/browser` legacy provider contracts remain compatible with
native/CLI callers, but the new website Browser panel does not activate them.
