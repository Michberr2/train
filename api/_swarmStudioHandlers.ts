import { reserveStudioQuota, studioLimitMessage } from './_limits'
import { cancellationSignal, throwIfCancelled } from './_requestCancellation'
import type { SwarmStudioHandler, SwarmStudioHandlers } from './_swarmStudio'

/** The ordinary email endpoint remains generation-only and keeps its public
 * contract. Swarm's durable background invocation reserves an explicit slot. */
const email: SwarmStudioHandler = async (req, res) => {
  const quota = await reserveStudioQuota(req, 'email')
  if (!quota.ok) return res.status(quota.status || 429).json({ error: studioLimitMessage('email draft', quota) })
  let status = 200, completed = false
  const capture = Object.create(res)
  capture.status = (code: number) => { status = code; res.status(code); return capture }
  capture.json = (value: unknown) => {
    throwIfCancelled()
    res.json(value)
    completed = status >= 200 && status < 300 && !!value && typeof value === 'object' && !('error' in value)
    return capture
  }
  try { throwIfCancelled(); return await (await import('./email')).default(req, capture) }
  finally { if (!completed || cancellationSignal()?.aborted) await quota.release() }
}

/** Load the SAME handlers used by ordinary Studio calls. Importing this
 * registry installs the real identity/quota policy hooks through _limits/_db.
 * No provider work starts until executeSwarmStudio validates a durable lease. */
export const swarmStudioHandlers: SwarmStudioHandlers = {
  doc: async (req, res) => (await import('./doc')).default(req, res),
  slides: async (req, res) => (await import('./slides')).default(req, res),
  sheet: async (req, res) => (await import('./sheet')).default(req, res),
  design: async (req, res) => (await import('./design')).default(req, res),
  cad: async (req, res) => (await import('./cad')).default(req, res),
  image: async (req, res) => (await import('./image')).default(req, res),
  video: async (req, res) => (await import('./video')).default(req, res),
  email,
}
