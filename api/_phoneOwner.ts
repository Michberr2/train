import { normalizePhone, userByPhone } from './_db'
import type { TeamClient } from './_team'
import { CloudflareStore } from './_cloudflareStore'

export function phoneOwnerId(): string {
  return (process.env.NALU_PHONE_OWNER_ID || '').trim().toLowerCase()
}
export function ownsPhone(userId: string | undefined): boolean {
  const owner = phoneOwnerId()
  return !!owner && userId === owner
}
export function accountPhoneNumber(userId: string): string {
  return ownsPhone(userId) ? normalizePhone(process.env.TELNYX_PHONE_NUMBER || '') : ''
}
export async function privatePhoneUser(c: TeamClient | CloudflareStore, from: string) {
  if (c instanceof CloudflareStore) {
    const phone = normalizePhone(from)
    if (!phone) return null
    const rows = (await c.query('SELECT id,display_name FROM nalu_users WHERE phone=? LIMIT 2', [phone])).results
    return rows.length === 1 && ownsPhone(String(rows[0].id)) ? { id: String(rows[0].id), display_name: String(rows[0].display_name || '') } : null
  }
  const user = await userByPhone(c as any, from)
  return user && ownsPhone(user.id) ? user : null
}
