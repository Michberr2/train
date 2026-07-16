// User-tunable model settings for Inkling: reasoning level + answer token
// capacity. Persisted in localStorage and sent with every /api/chat request
// (the backend clamps + applies them). Kept tiny + framework-free so any
// component can read/write without prop-drilling.

export type ReasoningLevel = 'none' | 'low' | 'medium' | 'high'
export const REASONING_LEVELS: ReasoningLevel[] = ['none', 'low', 'medium', 'high']

// Reasoning: how much Inkling "thinks" before answering (routed to a hidden
// reasoning channel, so the visible answer stays clean either way).
export const REASONING_DESC: Record<ReasoningLevel, string> = {
  none: 'Fastest — answers directly, no deliberation',
  low: 'Light reasoning (recommended) — quick, still considered',
  medium: 'More deliberation for harder problems',
  high: 'Deepest reasoning — slowest, for the toughest tasks',
}

export interface NaluModelSettings {
  reasoning: ReasoningLevel
  maxTokens: number // answer token capacity (256–32000)
}

export const DEFAULT_SETTINGS: NaluModelSettings = { reasoning: 'low', maxTokens: 8192 }
export const MIN_TOKENS = 256
export const MAX_TOKENS = 32000

const KEY = 'nalu-model-settings'

export function getModelSettings(): NaluModelSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}')
    const reasoning: ReasoningLevel = REASONING_LEVELS.includes(raw.reasoning) ? raw.reasoning : DEFAULT_SETTINGS.reasoning
    const n = Number(raw.maxTokens)
    const maxTokens = Number.isFinite(n) ? Math.max(MIN_TOKENS, Math.min(MAX_TOKENS, Math.round(n))) : DEFAULT_SETTINGS.maxTokens
    return { reasoning, maxTokens }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function setModelSettings(patch: Partial<NaluModelSettings>): NaluModelSettings {
  const next = { ...getModelSettings(), ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent('nalu-settings-changed', { detail: next }))
  } catch {
    /* storage blocked — settings just won't persist */
  }
  return next
}
