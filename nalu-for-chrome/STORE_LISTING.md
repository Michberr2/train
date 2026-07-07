# Chrome Web Store — publish kit (paste-ready)

I can't publish for you (it needs your Google account + the one-time $5 fee +
Google's review). Everything below is copy-paste ready so it takes ~15 minutes.
Upload artifact: the zip at `client/public/nalu-for-chrome.zip` (= `https://n4lu.ai/nalu-for-chrome.zip`).

Dashboard: https://chrome.google.com/webstore/devconsole → Add new item → upload the zip → paste these fields.

---

## ⚠️ Two things to change BEFORE you submit (common rejections)

1. **Name — don't use "Chrome".** Google's branding policy rejects extension
   names that include "Chrome". Use a store name WITHOUT it. Recommended:
   **"Nalu — AI Browser Agent"**. (Keep "Nalu for Chrome" only as marketing copy.)
   → In `manifest.json`, change `"name": "Nalu for Chrome"` to `"name": "Nalu — AI Browser Agent"`, re-zip, then upload.
2. **The `debugger` permission gets extra scrutiny** and can slow or fail review.
   It's only used to make clicks more reliable. If review pushes back, I can ship a
   **lean variant without `debugger`** (content-script clicks only) — ask me and
   I'll generate it in a minute. You can submit WITH it first and fall back if needed.

---

## Store listing fields

**Name:** Nalu — AI Browser Agent

**Summary** (≤132 chars):
> Give Nalu a goal and it reads the page and does it for you — clicks, types, navigates — asking before anything consequential.

**Category:** Productivity / Workflow & Planning

**Language:** English

**Detailed description:**
> Nalu is an AI agent that works inside your browser. Open the side panel, type what you want done on the current page, and Nalu reads the page and carries it out — clicking, typing, scrolling, and navigating — so you don't have to.
>
> • Just describe the goal. "Find the cheapest direct flight next Friday." "Summarize this article." "Fill this form with my details and stop before sending."
> • You stay in control. Nalu asks for one-click approval before anything consequential — purchases, sending, submitting, deleting, or leaving the site.
> • It sees the page like you do. Nalu uses the page structure plus a visual read of the screen, so it works on real, modern websites.
> • Save & schedule. Turn a task into a one-click re-run, or have it run on a daily/hourly schedule.
> • Multi-tab. Nalu can open, switch, and work across tabs to finish a job.
>
> Nalu acts only on the tab you point it at, and the AI runs on Nalu's own servers — there's no API key to set up. You can stop a run at any time.
>
> Note: Nalu can't act on Chrome's own internal pages (chrome://, the Web Store), and it never solves CAPTCHAs.

**Single purpose** (required field):
> Nalu lets the user accomplish tasks on the current web page by describing a goal in natural language; the extension reads the active tab and performs the browser actions (click, type, scroll, navigate) needed to complete it, with user confirmation for consequential actions.

**Privacy policy URL:** https://n4lu.ai/privacy

**Homepage URL:** https://n4lu.ai

---

## Permission justifications (paste one per permission)

- **activeTab / host permissions (http/https):** The agent must read and act on the page the user asks it to operate on; it works on whatever site the user is using.
- **scripting:** To read the page's interactive elements and perform the user's requested actions (click/type/scroll) on the active tab.
- **tabs:** To know the current page, and to open/switch/close tabs when a task spans multiple tabs.
- **storage:** To save the user's reusable tasks locally (never sent anywhere except as the task goal text when the user runs it).
- **sidePanel:** The agent's UI lives in the side panel.
- **debugger:** Used to dispatch reliable input events (clicks/keystrokes) on sites that block synthetic events, so requested actions actually work. Only attached during an active run and detached immediately after.
- **alarms:** To run a user-saved task on a daily/hourly schedule the user explicitly sets.
- **notifications:** To notify the user when a scheduled (background) task finishes.

---

## Data usage / privacy practices (dashboard checkboxes)

- **What data is collected/used:** "Website content" (the page text + a screenshot of the active tab) and the user's typed goal, sent to Nalu's server (n4lu.ai) ONLY to compute the next action while a task is running. No selling of data. Saved tasks are stored locally in the browser.
- Check: does NOT sell data; uses data only for the single purpose above; data is transmitted over HTTPS.
- Provide the privacy policy URL above.

---

## Screenshots (required — at least 1, 1280×800 or 640×400)

Take these from the running extension (load unpacked, open the side panel):
1. The side panel with a goal typed in + the Run button.
2. A live run showing the step log (a couple of "click / type" steps).
3. The approval prompt ("Allow / Skip") on a consequential action.
4. Saved tasks chips with a schedule set.

(Optional promo tile: 440×280. A simple Nalu wolf on the brand navy works.)

---

## After it's published

You'll get a URL like `https://chromewebstore.google.com/detail/nalu-ai-browser-agent/<id>`.
Give it to me (or set `VITE_CHROME_STORE_URL=<url>` in Vercel env) and the
website's "Nalu for Chrome" button auto-changes to a one-click **"Add to Chrome."**
No code change needed.
