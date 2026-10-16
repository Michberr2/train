import { CloudflareStore, type CloudflareStatement } from './_cloudflareStore'
import { hashPassword, newRecoveryCode, newSalt, newToken, normalizeRecoveryCode, sha256 } from './_db'

export type CloudflareAccount = { id: string; displayName: string; phone: string | null }
type AccountRow = { id: string; display_name: string; phone?: string | null; salt: string; hash: string; recovery_hash?: string | null }
const account = (row: Record<string, unknown>): CloudflareAccount => ({ id: String(row.id), displayName: String(row.display_name), phone: row.phone ? String(row.phone) : null })
const statement = (sql: string, params: CloudflareStatement['params'] = []): CloudflareStatement => ({ sql, params })
const validatePassword = (password: string) => { if (typeof password !== 'string' || password.length < 8) throw new Error('Password must be at least 8 characters.') }

/** Password work stays on the application server. D1 receives only hashes and
 * explicit atomic operations; existing password/session formats are unchanged. */
export class CloudflareAccounts {
  constructor(private store: CloudflareStore) {}
  async current(token: string | null): Promise<CloudflareAccount | null> {
    if (!token) return null
    const result = await this.store.query('SELECT u.id,u.display_name,u.phone FROM nalu_sessions s JOIN nalu_users u ON u.id=s.user_id WHERE s.token=?', [token])
    return result.results[0] ? account(result.results[0]) : null
  }
  async signup(id: string, displayName: string, password: string) {
    validatePassword(password)
    if (!id || id.length > 320 || !displayName) throw new Error('Enter an email or username.')
    const salt = newSalt(), hash = hashPassword(password, salt), recoveryCode = newRecoveryCode(), token = newToken()
    const result = await this.store.batch([
      statement('INSERT INTO nalu_users(id,display_name,salt,hash,recovery_hash) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id,display_name,phone', [id, displayName, salt, hash, sha256(normalizeRecoveryCode(recoveryCode))]),
      statement('INSERT INTO nalu_sessions(token,user_id) SELECT ?,id FROM nalu_users WHERE id=? AND salt=? AND hash=?', [token, id, salt, hash]),
    ])
    const row = result.results[0].results[0]
    return row ? { user: account(row), token, recoveryCode } : null
  }
  async signin(id: string, password: string) {
    const found = await this.store.query<AccountRow>('SELECT id,display_name,salt,hash,recovery_hash,phone FROM nalu_users WHERE id=?', [id])
    const user = found.results[0]
    if (!user || hashPassword(password, user.salt) !== user.hash) return null
    const token = newToken(), recoveryCode = user.recovery_hash ? undefined : newRecoveryCode()
    const statements = [statement('INSERT INTO nalu_sessions(token,user_id) SELECT ?,id FROM nalu_users WHERE id=? AND salt=? AND hash=? RETURNING token', [token, id, user.salt, user.hash])]
    if (recoveryCode) statements.push(statement(`UPDATE nalu_users SET recovery_hash=? WHERE id=? AND NULLIF(recovery_hash,'') IS NULL
      AND EXISTS(SELECT 1 FROM nalu_sessions WHERE token=?) RETURNING recovery_hash`, [sha256(normalizeRecoveryCode(recoveryCode)), id, token]))
    const result = await this.store.batch(statements)
    if (!result.results[0].results.length) return null // Password changed during sign-in.
    const issuedRecoveryCode = recoveryCode && result.results[1].results.length ? recoveryCode : undefined
    return { user: account(user), token, ...(issuedRecoveryCode ? { recoveryCode: issuedRecoveryCode } : {}) }
  }
  async signout(token: string | null): Promise<void> {
    if (token) await this.store.batch([statement('DELETE FROM nalu_sessions WHERE token=?', [token])])
  }
  async updateProfile(token: string, values: { displayName?: string; phone?: string | null }): Promise<CloudflareAccount | null> {
    const fields: string[] = [], params: CloudflareStatement['params'] = []
    if (values.displayName !== undefined) { fields.push('display_name=?'); params.push(values.displayName) }
    if (values.phone !== undefined) { fields.push('phone=?'); params.push(values.phone) }
    if (!fields.length) throw new Error('nothing to update')
    params.push(token)
    const result = await this.store.batch([statement(`UPDATE nalu_users SET ${fields.join(',')} WHERE id=(SELECT user_id FROM nalu_sessions WHERE token=?) RETURNING id,display_name,phone`, params)])
    return result.results[0].results[0] ? account(result.results[0].results[0]) : null
  }
  async createPasswordReset(id: string) {
    const raw = newToken()
    const result = await this.store.batch([
      statement('INSERT INTO nalu_password_resets(token_hash,user_id,expires_at) SELECT ?,id,? FROM nalu_users WHERE id=? RETURNING user_id', [sha256(raw), new Date(Date.now() + 3600000).toISOString(), id]),
      statement('SELECT id,display_name,phone FROM nalu_users WHERE id=?', [id]),
    ])
    return result.results[0].results.length ? { user: account(result.results[1].results[0]), resetToken: raw } : null
  }
  async resetPassword(resetToken: string, password: string) {
    validatePassword(password)
    if (!resetToken) return null
    return this.replacePassword(password, {
      where: "id=(SELECT user_id FROM nalu_password_resets WHERE token_hash=? AND used=0 AND julianday(expires_at)>julianday('now'))",
      params: [sha256(resetToken)],
    })
  }
  async resetWithCode(id: string, code: string, password: string) {
    validatePassword(password)
    if (!id || !normalizeRecoveryCode(code)) return null
    const recoveryCode = newRecoveryCode()
    const result = await this.replacePassword(password, { where: 'id=? AND recovery_hash=?', params: [id, sha256(normalizeRecoveryCode(code))] }, recoveryCode)
    return result ? { ...result, recoveryCode } : null
  }
  private async replacePassword(password: string, condition: { where: string; params: CloudflareStatement['params'] }, recoveryCode?: string): Promise<{ user: CloudflareAccount; token: string } | null> {
    const salt = newSalt(), hash = hashPassword(password, salt), token = newToken()
    const updateParams: CloudflareStatement['params'] = [salt, hash]
    if (recoveryCode) updateParams.push(sha256(normalizeRecoveryCode(recoveryCode)))
    updateParams.push(...condition.params || [])
    // The new random salt/hash identifies only the account changed by this
    // batch. Failed or replayed proofs cannot revoke sessions or mint a token.
    const changedUser = 'SELECT id FROM nalu_users WHERE salt=? AND hash=?'
    const result = await this.store.batch([
      statement(`UPDATE nalu_users SET salt=?,hash=?${recoveryCode ? ',recovery_hash=?' : ''} WHERE ${condition.where} RETURNING id,display_name,phone`, updateParams),
      statement(`UPDATE nalu_password_resets SET used=1 WHERE user_id IN (${changedUser})`, [salt, hash]),
      statement(`DELETE FROM nalu_sessions WHERE user_id IN (${changedUser})`, [salt, hash]),
      statement(`INSERT INTO nalu_sessions(token,user_id) SELECT ?,id FROM nalu_users WHERE salt=? AND hash=?`, [token, salt, hash]),
    ])
    return result.results[0].results[0] ? { user: account(result.results[0].results[0]), token } : null
  }
}
