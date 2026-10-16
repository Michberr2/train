import crypto from 'node:crypto'

function key(): Buffer {
  const value = process.env.CONN_SECRET || process.env.CRON_SECRET || process.env.DATABASE_URL
  if (!value) throw new Error('Connection encryption is not configured.')
  return crypto.createHash('sha256').update(value).digest()
}
export function encryptConnection(value: string): string {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`
}
export function decryptConnection(value: string): string {
  const [iv, tag, data] = value.split(':')
  if (!/^[a-f0-9]{24}$/.test(iv || '') || !/^[a-f0-9]{32}$/.test(tag || '') || !/^(?:[a-f0-9]{2})+$/.test(data || '')) throw new Error('Reconnect this account to restore its credentials.')
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'hex'))
    decipher.setAuthTag(Buffer.from(tag, 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8')
  } catch { throw new Error('Reconnect this account to restore its credentials.') }
}
