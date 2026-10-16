// Nalu system health check — one endpoint to confirm the whole backend is up.
// GET /api/health         → env + DB + provider-chain config (fast, free)
// GET /api/health?deep=1  → also pings the live LLM (Inkling) with a 1-token call
//
// Every check is isolated in its own try/catch so a single failing dependency
// downgrades the report to "degraded"/"down" but never throws. Never leaks secrets
// (only booleans + labels). Safe to hit from uptime monitors on any interval.
import { cors } from './_cors'
import { connectionBackend } from './_connectionBackend'
import { providerChain, chatComplete } from './_llm'

type Check = { ok: boolean; detail?: string; ms?: number }

function env(name: string): boolean {
  const v = process.env[name]
  return !!(v && v.trim())
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; detail?: string; value?: T }> {
  const t0 = Date.now()
  try {
    const value = await fn()
    return { ok: true, ms: Date.now() - t0, value }
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: e instanceof Error ? e.message : 'error' }
  }
}

async function checkDb(): Promise<Check> {
  const r = await timed(async () => {
    const backend = connectionBackend(), c=backend.client
    await backend.connect()
    try {
      await c.query('SELECT 1')
    } finally {
      await backend.close().catch(() => {})
    }
    return true
  })
  return { ok: r.ok, ms: r.ms, detail: r.ok ? undefined : r.detail }
}

async function checkLlm(): Promise<Check> {
  const r = await timed(async () => {
    const out = await chatComplete([{ role: 'user', content: 'Reply with: ok' }], {
      maxTokens: 5,
      timeoutMs: 15000,
      reasoningEffort: 'none',
      temperature: 0,
      retryPrimary: false,
    })
    if (!out || !out.trim()) throw new Error('empty completion')
    return out.trim().slice(0, 40)
  })
  return { ok: r.ok, ms: r.ms, detail: r.ok ? `answered: ${r.value}` : r.detail }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'GET only' })
    return
  }
  const deep = /(?:\?|&)deep=1/.test(req.url || '') || req.query?.deep === '1'

  // Config presence — no external calls, cannot fail.
  const chain = (() => {
    try {
      return providerChain().map((p) => p.label)
    } catch {
      return []
    }
  })()
  const config = {
    database: process.env.NALU_STORAGE_BACKEND === 'cloudflare' ? env('CLOUDFLARE_DATA_URL') && env('CLOUDFLARE_DATA_SECRET') : env('DATABASE_URL'),
    databaseProvider: process.env.NALU_STORAGE_BACKEND === 'cloudflare' ? 'cloudflare-d1' : 'postgresql',
    llmPrimary: env('TINKER_API_KEY'),
    llmModel: process.env.NALU_DEFAULT_MODEL || 'thinkingmachines/Inkling',
    providerChain: chain, // e.g. ['primary','fallback','emergency'] — resilience layers configured
    media: { gemini: env('GEMINI_API_KEY') || env('GOOGLE_AI_API_KEY'), fal: env('FAL_KEY') || env('FAL_API_KEY') },
    email: env('RESEND_API_KEY'),
    cronSecret: env('CRON_SECRET'),
  }

  const checks: Record<string, Check> = {}
  // DB is critical → always checked (fast, 8s connect cap so it can't hang).
  checks.db = config.database ? await checkDb() : { ok: false, detail: 'Database service is not configured' }
  // LLM ping only on ?deep=1 (costs a token + a couple seconds).
  if (deep) checks.llm = config.llmPrimary ? await checkLlm() : { ok: false, detail: 'TINKER_API_KEY not set' }

  const critical = [checks.db.ok, config.llmPrimary, chain.length > 0]
  const allChecksOk = Object.values(checks).every((c) => c.ok)
  const status = critical.every(Boolean) && allChecksOk ? 'ok' : critical.some(Boolean) ? 'degraded' : 'down'

  res.setHeader('Cache-Control', 'no-store')
  res.status(status === 'down' ? 503 : 200).json({
    status,
    ok: status === 'ok',
    ts: new Date().toISOString(),
    config,
    checks,
  })
}
