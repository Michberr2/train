# Nalu for Chrome

Nalu, in your browser. Open the side panel, give Nalu a goal, and it reads the
**current tab** and acts on it for you — clicking, typing, scrolling, navigating —
asking for your approval before anything consequential (buy / pay / send / delete /
submit / leaving the site).

A Manifest V3 extension
that controls your *real, already-logged-in* browser, using **DOM grounding**
(numbered element refs, not pixel guessing) for reliability. The "brain" runs on
Nalu's servers (`https://n4lu.ai/api/web` (action `agentstep`)) — no API key needed in the extension.

## How it works

```
side panel (goal) ──▶ background worker
                         │  1. snapshot the active tab  (content.js → interactive elements + text)
                         │  2. POST {action:agentstep, goal, page, history} ──▶ https://n4lu.ai/api/web
                         │  3. get ONE next action  {click|type|scroll|navigate|ask|finish}
                         │  4. confirm if consequential, then execute via content.js
                         └─ repeat (max 25 steps)
```

- **DOM-grounded:** `content.js` lists the visible interactive elements (links,
  buttons, inputs, …) each with a numeric `ref`; the model picks a ref to act on.
- **Safe by default:** consequential actions (purchase/pay/send/delete/submit, or
  navigating to a different site) require a one-click **Allow** in the panel.
- **Bound to the observed page:** each action retains the original tab and Chrome
  document identity. Navigation, a changed target, or a tab switch while Nalu is
  thinking or awaiting approval invalidates the action. Coordinate clicks and
  non-search submissions require review even when the typed text is innocuous.
  Approval is specific to one proposed action and shows its page and target.
- **It can ask:** if it needs info or a choice, it pauses and asks you.

## Install (load unpacked)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `nalu-for-chrome/` folder.
4. Pin "Nalu for Chrome" and click it (or its toolbar icon) to open the side panel.
5. Open any normal web page (not a `chrome://` page), type a goal, and hit **Run**.

Requires Chrome 116 or newer. After updating the extension, reload existing tabs
so their content script uses the new document-bound action protocol.

> The `/api/web` agentstep action must be deployed on n4lu.ai (it is — it ships with the
> main app). To point at a different backend, change `API` in `background.js`.

## Notes & limits

- Works on normal http/https pages. Chrome system pages (`chrome://`, the web
  store) can't be scripted — that's a browser restriction.
- Hybrid grounding: DOM refs PLUS a viewport screenshot sent to a vision model, so it also handles <canvas>/custom UIs (via coordinate clicks). Saved tasks let you re-run a goal in one click.
- Multi-tab actions use the tab IDs observed with the page, rather than reusing
  an index after the tab strip changes. Scheduled tasks never auto-approve
  consequential actions; tasks requiring a reply must be run interactively.
- Input executes through the content script, with validation and dispatch in the
  same document. Sites that require trusted native input may need the user to
  perform that step manually. Tab-only debugger input cannot enforce document
  binding during navigation and is not used as a fallback.
- Search submits are automatic only for an explicitly identified GET search
  form. Unknown forms and coordinate clicks require review. This is a bounded
  browser agent (up to 25 steps); page content and model output remain untrusted.

## Get it from inside Nalu

The n4lu.ai app surfaces this under **Plugins → "Get Nalu for Chrome"** with a
one-click **Download** (served at `/nalu-for-chrome.zip`) and these same steps.

## Publish to the Chrome Web Store (one-click install for users)

The downloadable zip *is* the Web Store upload artifact:

1. Rebuild the zip after changes: `cd nalu-for-chrome && zip -rq ../client/public/nalu-for-chrome.zip . -x '*.DS_Store'`.
2. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) (one-time $5 registration), **Add new item**, upload the zip.
3. Listing: name "Nalu for Chrome", category Productivity, add screenshots of the side panel, a 128px icon (already in `icons/`), and a privacy policy URL (n4lu.ai/privacy). Justify the `tabs`, `scripting`, and host permissions in the review notes ("AI agent that acts on the user's observed page with action-specific confirmation and document binding").
4. Submit for review. Once approved, users install in one click and you can link the store URL from the in-app card.

## Config (optional)

The backend model is configurable via Vercel env on n4lu.ai:
`NALU_AGENT_MODEL`, `NALU_AGENT_BASE_URL`, `NALU_AGENT_API_KEY` (defaults to the
same engine the chat uses).
