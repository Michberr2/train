# Automatic hosted browser

Opening Browser in the signed-in website starts an account-owned Vercel Sandbox
without user installation, a local companion, or a pairing code. The default
Browser panel and chat tools use the authenticated `host_*` actions of
`/api/browser`. Older native/CLI browser actions remain unchanged.

The API verifies the Nalu session before looking up hosting resources. An HMAC
of the server-verified account ID determines the private machine name and service
capability. The caller cannot supply either identity. The runtime endpoint and
capability never reach the frontend or model. Each account has its own microVM;
its agents have separate Chromium processes, profile directories and virtual input.
The existing private-address blocking proxy applies to browser network requests.

The provider SDK uses Vercel OIDC in production. `NALU_BROWSER_SNAPSHOT_ID` selects
a prepared base image containing Linux libraries and Chromium 153. The base has
no user profiles or credentials. `services/browser-cloud/build.mjs` builds the
reviewed runtime bundle; `check-hosted-browser-build.mjs` checks its source hashes.
The backend uploads that bundle when starting or resuming the owned machine.
No Vercel credential is passed into the machine. A Nalu session token is retained
in runtime memory for AI calls, never in the Chromium environment or profile.

A server-side per-owner lease serializes provisioning and control across tabs.
Starting a stopped machine reserves one of six daily sessions per account before
provider work. Polling/status never resumes a stopped machine. Each session has
a hard fifteen-minute lifetime and two active Chromium processes; additional
agent tasks queue. The runtime closes browsers before the deadline to flush
profiles. Persistent snapshots retain login cookies subject to the destination
website's expiry; account snapshots expire after thirty days of inactivity.
Interrupted tasks are not silently restarted. A reported model completion is not
independent proof of a successful external action.

Hosting is metered under the existing Vercel plan; it is not an unlimited free
browser fleet. No plan upgrade is part of this change. Browser inference runs online when the user submits a browser task; there is no
separate enable/allow step. Other local AI preferences remain unchanged. Progress,
help requests and results update the originating chat. Takeover and website login
stay inside the browser viewer.

Checks cover API owner isolation, allocation-before-auth rejection, session quota,
leases, sanitized provider errors, automatic UI startup, no pairing/setup form,
manual input, automatic browser-task dispatch, chat result delivery, and unchanged
local inference for other AI requests. A live disposable two-machine check
also verified independent account/agent cookies and cookie persistence after a
stop/resume. Native and CLI legacy browser contracts must continue passing.
