// Nalu auth — server-backed (Neon Postgres via /api/auth), shared across
// n4lu.ai/.com and all devices. A session token is kept in localStorage; the
// account itself lives in the database. Same function shapes as before so the
// AuthModal/UI didn't change — just `currentUser`/`signOut` are now async.

const TOKEN_KEY = 'nalu-token'
let authIntent = 0

type Session = { token: string | null; intent: number }
const SESSION_CHANGED = 'The sign-in request or account changed. Please try again.'

function sessionSnapshot(): Session {
  return { token: getToken(), intent: authIntent }
}

function isCurrentSession(session: Session): boolean {
  return session.intent === authIntent && session.token === getToken()
}

export interface PublicUser {
  id: string
  displayName: string
  phone?: string | null // E.164, for the phone-call feature; null/absent = not set
}

function isPublicUser(value: unknown): value is PublicUser {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const user = value as Record<string, unknown>
  return typeof user.id === 'string' && user.id.trim().length > 0
    && typeof user.displayName === 'string' && user.displayName.trim().length > 0
}

type Result =
  | { ok: true; user: PublicUser; recoveryCode?: string }
  | { ok: false; error: string }

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

async function callAuth(
  action: string,
  payload: Record<string, unknown>,
  token: string | null = getToken(),
): Promise<Record<string, unknown>> {
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // An explicit header also prevents the global fetch wrapper from adding
      // a newer account's token to a request started without a session.
      Authorization: token ? `Bearer ${token}` : '',
    },
    body: JSON.stringify({ action, token, ...payload }),
  })
  const value: unknown = await res.json().catch(() => ({}))
  const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return res.ok ? body : { ...body, ok: false }
}

async function authenticate(
  action: string,
  payload: Record<string, unknown>,
  fallbackError: string,
  includeRecoveryCode = true,
): Promise<Result> {
  // A newer attempt wins even when it fails: an older successful reply must
  // never silently sign the user into the account they have moved away from.
  authIntent += 1
  const session = sessionSnapshot()
  try {
    const r = await callAuth(action, payload, session.token)
    if (!isCurrentSession(session)) return { ok: false, error: SESSION_CHANGED }
    if (r.ok === true && typeof r.token === 'string' && r.token.trim() && isPublicUser(r.user)) {
      localStorage.setItem(TOKEN_KEY, r.token)
      return {
        ok: true,
        user: r.user,
        ...(includeRecoveryCode ? { recoveryCode: r.recoveryCode as string | undefined } : {}),
      }
    }
    return { ok: false, error: (r.error as string) || fallbackError }
  } catch {
    return { ok: false, error: isCurrentSession(session) ? 'Network error. Please try again.' : SESSION_CHANGED }
  }
}

export async function signUp(
  rawId: string,
  password: string,
  displayName?: string,
): Promise<Result> {
  return authenticate('signup', { email: rawId, password, displayName }, 'Sign up failed.')
}

export async function signIn(rawId: string, password: string): Promise<Result> {
  return authenticate('signin', { email: rawId, password }, 'Incorrect email/username or password.')
}

// Step 1: ask for a reset link. An accepted request does not reveal whether
// the account exists; transport/server failures must still report failure.
export async function requestReset(email: string): Promise<{ ok: boolean; emailConfigured?: boolean }> {
  try {
    const r = await callAuth('request-reset', { email, origin: window.location.origin })
    return { ok: r.ok === true, emailConfigured: r.emailConfigured as boolean | undefined }
  } catch {
    return { ok: false }
  }
}

// Email-free reset: prove ownership with the recovery code shown at signup.
// On success the user is signed in and a NEW recovery code is returned.
export async function resetWithCode(email: string, code: string, password: string): Promise<Result> {
  return authenticate('reset-with-code', { email, code, password }, 'Could not reset your password.')
}

// Step 2: set a new password using the emailed token. On success the user is
// signed in (a fresh session token is stored).
export async function resetPassword(token: string, password: string): Promise<Result> {
  return authenticate('reset-password', { token, password }, 'Could not reset your password.', false)
}

// Update the signed-in user's profile (display name and/or phone number). Pass
// phone: '' to clear it. Returns the refreshed user.
export async function updateProfile(patch: { displayName?: string; phone?: string }): Promise<Result> {
  const session = sessionSnapshot()
  try {
    const r = await callAuth('update-profile', patch, session.token)
    if (!isCurrentSession(session)) return { ok: false, error: SESSION_CHANGED }
    if (r.ok === true && isPublicUser(r.user)) return { ok: true, user: r.user }
    return { ok: false, error: (r.error as string) || 'Could not save your profile.' }
  } catch {
    return { ok: false, error: isCurrentSession(session) ? 'Network error. Please try again.' : SESSION_CHANGED }
  }
}

export async function signOut(): Promise<void> {
  authIntent += 1
  const token = getToken()
  localStorage.removeItem(TOKEN_KEY)
  if (!token) return
  try {
    await callAuth('signout', {}, token)
  } catch {
    // ignore network errors on sign-out
  }
}

export async function currentUser(): Promise<PublicUser | null> {
  const session = sessionSnapshot()
  if (!session.token) return null
  try {
    const r = await callAuth('me', {}, session.token)
    return isCurrentSession(session) && r.ok !== false && isPublicUser(r.user) ? r.user : null
  } catch {
    return null
  }
}
