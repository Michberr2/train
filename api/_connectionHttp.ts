import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { request } from 'node:https'

const blocked = new BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(address, prefix, 'ipv4')
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [address, prefix] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16]] as const) blocked.addSubnet(address, prefix, 'ipv6')
export function isPublicConnectionAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}
export function webhookUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Enter a valid public HTTPS webhook URL.') }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) || (isIP(host) && !isPublicConnectionAddress(host))) throw new Error('Use a public HTTPS webhook URL.')
  return url
}

/** Pin the socket to checked DNS answers, preserving the original TLS host.
 * Reject redirects so authorization never follows a different destination. */
export async function requestWebhook(value: string, options: { method: 'HEAD' | 'POST'; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number }> {
  const url = webhookUrl(value)
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: options.method, headers: options.headers, signal: AbortSignal.timeout(20000),
      lookup: (hostname, options: any, done: any) => {
        lookup(hostname, { all: true, verbatim: true }).then(addresses => {
          if (!addresses.length || addresses.some(item => !isPublicConnectionAddress(item.address))) { done(new Error('Webhook must resolve to a public address.')); return }
          const selected = addresses.find(item => !options.family || item.family === options.family) || addresses[0]
          options.all ? done(null, [selected]) : done(null, selected.address, selected.family)
        }).catch(() => done(new Error('The webhook address could not be resolved.')))
      },
    }, response => {
      const status = response.statusCode || 502
      response.destroy()
      resolve({ ok: status >= 200 && status < 300, status })
    })
    req.on('error', error => reject(new Error(error.name === 'AbortError' ? 'The webhook timed out. Check delivery before retrying.' : 'The webhook could not be reached. Check its URL and network access.')))
    req.end(options.body)
  })
}
