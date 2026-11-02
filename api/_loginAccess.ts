// Optional private access window. No passwords or account data live in source.
export function restrictedLoginEmail(): string {
  return (process.env.NALU_ALLOWED_LOGIN_EMAIL || '').trim().toLowerCase()
}
export function loginAllowed(id: unknown): boolean {
  const allowed = restrictedLoginEmail()
  return !allowed || (typeof id === 'string' && id.trim().toLowerCase() === allowed)
}
export function blockedAccountAction(action: string, email: unknown): boolean {
  if (!restrictedLoginEmail()) return false
  // Recovery and signup cannot mint alternate sessions during private access.
  return ['signup', 'request-reset', 'reset-password', 'reset-with-code'].includes(action)
    || action === 'signin' && !loginAllowed(email)
}
