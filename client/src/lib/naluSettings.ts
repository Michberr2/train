// User-tunable model settings for Inkling: reasoning level + answer token
// capacity. Persisted in localStorage and sent with every /api/chat request
// (the backend clamps + applies them). Kept tiny + framework-free so any
// component can read/write without prop-drilling.

export type ReasoningLevel = 'none' | 'min' | 'low' | 'medium' | 'high' | 'xhigh'
export const REASONING_LEVELS: ReasoningLevel[] = ['none', 'min', 'low', 'medium', 'high', 'xhigh']

// Effort controls model deliberation. Answer length follows the user's request;
// the separate token setting controls capacity, not a target response length.
export const REASONING_DESC: Record<ReasoningLevel, string> = {
  none: 'Fastest — answers directly, no deliberation',
  min: 'Barely deliberates — quickest considered answer',
  low: 'Light reasoning — prioritizes speed',
  medium: 'Balanced reasoning (recommended)',
  high: 'More deliberation for complex tasks',
  xhigh: 'Most deliberation — can take longer',
}
// Shown next to the level so "XHigh" reads clean in the UI.
export const REASONING_LABEL: Record<ReasoningLevel, string> = {
  none: 'None', min: 'Min', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh',
}

export interface NaluModelSettings {
  reasoning: ReasoningLevel
  maxTokens: number // answer token capacity (256–32000)
  webSearch: boolean // allow live web search / auto-research
  streaming: boolean // stream the reply live vs. reveal it all at once
  systemPrompt: string // custom System prompt from the chat drawer (extra instructions)
}

// Web chat favors complete answers. Keep output capacity separate from effort.
export const DEFAULT_SETTINGS: NaluModelSettings = { reasoning: 'medium', maxTokens: 32000, webSearch: true, streaming: true, systemPrompt: '' }
export const MIN_TOKENS = 256
export const MAX_TOKENS = 32000

const KEY = 'nalu-model-settings'
const SETTINGS_VERSION = 4

export function getModelSettings(): NaluModelSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}')
    // Upgrade the old stock fast preset once, preserving customized preferences.
    const stockFast = raw.v === 3 && raw.reasoning === 'low' && raw.maxTokens === 32000 && raw.webSearch === true && raw.streaming === true && !raw.systemPrompt
    if (stockFast) raw.reasoning = 'medium'
    const reasoning: ReasoningLevel = REASONING_LEVELS.includes(raw.reasoning) ? raw.reasoning : DEFAULT_SETTINGS.reasoning
    const n = Number(raw.maxTokens)
    const maxTokens = Number.isFinite(n) ? Math.max(MIN_TOKENS, Math.min(MAX_TOKENS, Math.round(n))) : DEFAULT_SETTINGS.maxTokens
    const webSearch = typeof raw.webSearch === 'boolean' ? raw.webSearch : DEFAULT_SETTINGS.webSearch
    const streaming = typeof raw.streaming === 'boolean' ? raw.streaming : DEFAULT_SETTINGS.streaming
    const systemPrompt = typeof raw.systemPrompt === 'string' ? raw.systemPrompt : DEFAULT_SETTINGS.systemPrompt
    const settings = { reasoning, maxTokens, webSearch, streaming, systemPrompt }
    if (raw.v !== SETTINGS_VERSION) try { localStorage.setItem(KEY, JSON.stringify({ ...settings, v: SETTINGS_VERSION })) } catch { /* storage unavailable */ }
    return settings
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function setModelSettings(patch: Partial<NaluModelSettings>): NaluModelSettings {
  const next = { ...getModelSettings(), ...patch }
  try {
    // Persist WITH the version marker so a user's own change isn't re-migrated away.
    localStorage.setItem(KEY, JSON.stringify({ ...next, v: SETTINGS_VERSION }))
    window.dispatchEvent(new CustomEvent('nalu-settings-changed', { detail: next }))
  } catch {
    /* storage blocked — settings just won't persist */
  }
  return next
}
