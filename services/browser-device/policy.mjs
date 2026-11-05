import crypto from 'node:crypto'

export const origins = new Set(['https://n4lu.com', 'https://www.n4lu.com', 'https://n4lu.ai', 'https://www.n4lu.ai'])
export const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)
export const secret = () => crypto.randomBytes(32).toString('base64url')
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
export function webUrl(value) {
  const url = new URL(String(value))
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error('Use a public website address.')
  const host = url.hostname.replace(/\.$/, '')
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') || host.includes(':') || /^\d+\./.test(host)) throw Error('Use a public website address.')
  return url.href
}
export function validateAction(a, count, tabs) {
  if (!a || typeof a !== 'object') throw Error('Missing browser action.')
  if (['click', 'type'].includes(a.type) && (!Number.isInteger(a.ref) || a.ref < 0 || a.ref >= count)) throw Error('The page target changed. Review before continuing.')
  switch (a.type) {
    case 'type': if (typeof a.text !== 'string' || a.text.length > 12000) throw Error('Invalid text.'); break
    case 'press': if (typeof a.key !== 'string' || !/^(?:(?:Control|Meta|Shift|Alt)\+){0,3}(?:[a-zA-Z0-9]|Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)$/.test(a.key)) throw Error('Invalid key.'); break
    case 'type_text': if (typeof a.text !== 'string' || a.text.length > 12000) throw Error('Invalid text.'); break
    case 'drag': if (![a.x,a.y,a.x2,a.y2].every(Number.isFinite) || a.x < 0 || a.y < 0 || a.x2 < 0 || a.y2 < 0 || a.x >= 1440 || a.x2 >= 1440 || a.y >= 900 || a.y2 >= 900) throw Error('Invalid drag.'); break
    case 'click': break
    case 'click_at': if (![a.x, a.y].every(Number.isFinite) || a.x < 0 || a.y < 0 || a.x >= 1440 || a.y >= 900) throw Error('Invalid coordinates.'); break
    case 'navigate': case 'newtab': webUrl(a.url); break
    case 'switchtab': if (!Number.isInteger(a.index) || a.index < 0 || a.index >= tabs) throw Error('Unknown tab.'); break
    case 'closetab': break
    case 'scroll': if (!['up', 'down', 'top', 'bottom'].includes(a.direction)) throw Error('Invalid scroll.'); break
    case 'ask': if (typeof a.question !== 'string') throw Error('Missing question.'); break
    case 'finish': if (typeof a.summary === 'string' && /engine.*(?:unavailable|not configured)|could not parse an action/i.test(a.summary)) throw Error('The browser AI engine is unavailable. No completion was verified.'); if (typeof a.summary !== 'string' || !a.summary.trim()) throw Error('Missing result.'); break
    default: throw Error('Unsupported browser action. Review the page before continuing.')
  }
  return a
}
