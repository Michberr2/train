// Nalu auth — server-backed (Neon Postgres via /api/auth), shared across
// n4lu.ai/.com and all devices. A session token is kept in localStorage; the
// account itself lives in the database. Same function shapes as before so the
// AuthModal/UI didn't change — just `currentUser`/`signOut` are now async.

const TOKEN_KEY = 'nalu-token'

export interface PublicUser {
  id: string
  displayName: string
}

type Result =
  | { ok: true; user: PublicUser }
  | { ok: false; error: string }

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

async function callAuth(
  action: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const token = getToken()
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action, token, ...payload }),
  })
  return res.json().catch(() => ({}))
}

export async function signUp(
  rawId: string,
  password: string,
  displayName?: string,
): Promise<Result> {
  try {
    const r = await callAuth('signup', { email: rawId, password, displayName })
    if (r.ok && typeof r.token === 'string') {
      localStorage.setItem(TOKEN_KEY, r.token)
      return { ok: true, user: r.user as PublicUser }
    }
    return { ok: false, error: (r.error as string) || 'Sign up failed.' }
  } catch {
    return { ok: false, error: 'Network error. Please try again.' }
  }
}

export async function signIn(rawId: string, password: string): Promise<Result> {
  try {
    const r = await callAuth('signin', { email: rawId, password })
    if (r.ok && typeof r.token === 'string') {
      localStorage.setItem(TOKEN_KEY, r.token)
      return { ok: true, user: r.user as PublicUser }
    }
    return { ok: false, error: (r.error as string) || 'Incorrect email/username or password.' }
  } catch {
    return { ok: false, error: 'Network error. Please try again.' }
  }
}

export async function signOut(): Promise<void> {
  try {
    await callAuth('signout', {})
  } catch {
    // ignore network errors on sign-out
  }
  localStorage.removeItem(TOKEN_KEY)
}

export async function currentUser(): Promise<PublicUser | null> {
  if (!getToken()) return null
  try {
    const r = await callAuth('me', {})
    return (r.user as PublicUser) || null
  } catch {
    return null
  }
}
