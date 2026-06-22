# Train — Nalu Landing

Marketing landing carousel for Nalu with self-contained account sign-up /
sign-in. No backend, no database, no third-party services — authentication runs
entirely in the browser.

## Stack
- **client**: Vite + React 18 + TypeScript + Tailwind + Framer Motion (static SPA)
- **auth**: manual, client-side (`client/src/lib/localAuth.ts`) — accounts stored
  in the browser's `localStorage`, passwords PBKDF2-hashed via the Web Crypto API
- **hosting**: Vercel (static build + SPA rewrite, see `vercel.json`)

## Setup

```bash
# 1. Install
npm install

# 2. Run dev (client on :5180)
npm run dev
```

That's it — there's nothing to configure and nothing to sign up for. Open the
site, click **Create account**, and you're in.

## How auth works
- **Create account / Sign in** buttons on the hero (and a Sign in button in the
  nav) open a modal with email-or-username + password.
- Accounts and the active session live in `localStorage`. Passwords are never
  stored in plaintext — they're hashed with PBKDF2 (100k iterations, per-user
  salt) using the browser's built-in Web Crypto API.
- Once signed in, the hero shows a welcome card and the nav shows the user's
  name + a Sign out button.

### Security & limitations (read this)
This is **demo / MVP-grade** auth, intentionally dependency-free:
- Accounts do **not** sync across devices or browsers (data is per-browser).
- Anyone with access to the device can read or clear the stored accounts.
- There is no server enforcing anything — it gates/personalizes the UI, it does
  not protect sensitive data.

Web Crypto requires a secure context, so it works on `localhost` and on any
`https://` deployment (including Vercel).

### Upgrading to real auth later
The UI is decoupled from storage: `AuthModal`/`AuthPanel`/`NavBar` only call
`signUp` / `signIn` / `signOut` / `currentUser` from `client/src/lib/localAuth.ts`.
To make accounts real and secure, reimplement those four functions against a
backend (e.g. Vercel functions + a database), or swap in a hosted auth provider.
Social logins (Google / Apple / GitHub) can be added at that point — they each
require registering an OAuth app with the provider, which is why they're not
included in this no-signup version.

## Pages (carousel)
1. Meet Nalu — Hero + account sign-up / sign-in
2. Platform
3. Solutions
4. Pricing
5. Learn
