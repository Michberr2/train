// Deterministic portfolio proposal checks. This is not brokerage execution or a
// claim that model opinions are calibrated. Only user-attached policy JSON is
// authoritative; upstream model text cannot create balances, prices or limits.
export type FundAction = 'buy' | 'sell' | 'short' | 'cover' | 'hold'
export type FundRiskPolicy = {
  schema: 'nalu-fund-risk-v1'; currency: string; asOf: string
  equity: number; cash: number; minCash: number; maxPositionPct: number; maxSectorPct: number; maxGrossExposurePct: number
  maxQuoteAgeHours: number; tradeCostBps: number; allowShort: boolean; shortMarginPct: number
  positions: Array<{ ticker: string; quantity: number; price: number; priceAsOf: string; priceSource: string; sector: string; maxShares?: number; borrowLimitShares?: number }>
}
export type FundDecision = { ticker: string; action: FundAction; quantity: number; reasoning: string }
const obj = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
function json(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim()
  try { return JSON.parse(trimmed) } catch { throw new Error('The fund output must be complete structured JSON.') }
}
const bounded = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}.`)
  return value
}
const shares = (value: unknown, name: string, signed = false) => { const n = bounded(value, name, signed ? -1e9 : 0, 1e9); if (!Number.isSafeInteger(n)) throw new Error(`${name} must be a whole share quantity.`); return n }
const nonempty = (value: unknown, name: string, max = 300): string => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Missing or invalid ${name}.`); return value.trim() }
const ticker = (value: unknown) => { const t = nonempty(value, 'ticker', 20).toUpperCase(); if (!/^[A-Z0-9][A-Z0-9.^/-]*$/.test(t)) throw new Error('Invalid ticker.'); return t }
function timestamp(value: unknown, name: string, now: number, maxAgeHours: number): string {
  const s = nonempty(value, name, 50), parsed = Date.parse(s)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(s) || !Number.isFinite(parsed) || parsed > now + 300000 || now - parsed > maxAgeHours * 3600000) throw new Error(`${name} is stale, future-dated, or lacks a timezone.`)
  return s
}
export function parseFundRiskPolicy(policyText: string | undefined, now = Date.now()): FundRiskPolicy | null {
  if (!policyText?.trim()) return null
  let raw: unknown
  try { raw = JSON.parse(policyText) } catch { return null }
  const p = obj(raw)
  if (p?.schema !== 'nalu-fund-risk-v1') return null
  const currency = nonempty(p.currency, 'currency', 3)
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Policy requires a three-letter currency code.')
  const maxQuoteAgeHours = bounded(p.maxQuoteAgeHours, 'quote age limit', 1/60, 168)
  const asOf = timestamp(p.asOf, 'portfolio snapshot', now, maxQuoteAgeHours)
  if (!Array.isArray(p.positions) || !p.positions.length || p.positions.length > 200) throw new Error('Policy requires 1–200 explicit positions/watchlist prices.')
  const seen = new Set<string>()
  const positions = p.positions.map((value) => {
    const item = obj(value); if (!item) throw new Error('Invalid policy position.')
    const symbol = ticker(item.ticker)
    if (seen.has(symbol)) throw new Error(`Duplicate policy ticker ${symbol}.`)
    seen.add(symbol)
    return {
      ticker: symbol, quantity: shares(item.quantity, `${symbol} holding`, true), price: bounded(item.price, `${symbol} price`, 0.000001, 1e9),
      priceAsOf: timestamp(item.priceAsOf, `${symbol} price`, now, maxQuoteAgeHours), priceSource: nonempty(item.priceSource, `${symbol} price source`, 500), sector: nonempty(item.sector, `${symbol} sector`, 100),
      ...(item.maxShares != null ? { maxShares: shares(item.maxShares, `${symbol} share cap`) } : {}),
      ...(item.borrowLimitShares != null ? { borrowLimitShares: shares(item.borrowLimitShares, `${symbol} borrow limit`) } : {}),
    }
  })
  if (typeof p.allowShort !== 'boolean') throw new Error('Policy must explicitly set allowShort.')
  const policy: FundRiskPolicy = {
    schema: 'nalu-fund-risk-v1', currency, asOf, maxQuoteAgeHours, positions,
    equity: bounded(p.equity, 'equity', 0.01, 1e12), cash: bounded(p.cash, 'cash', 0, 1e12), minCash: bounded(p.minCash, 'minimum cash reserve', 0, 1e12),
    maxPositionPct: bounded(p.maxPositionPct, 'position cap', 0, 100), maxSectorPct: bounded(p.maxSectorPct, 'sector cap', 0, 100), maxGrossExposurePct: bounded(p.maxGrossExposurePct, 'gross exposure cap', 0, 1000),
    tradeCostBps: bounded(p.tradeCostBps, 'transaction costs', 0, 1000), allowShort: p.allowShort, shortMarginPct: bounded(p.shortMarginPct, 'short collateral percent', 100, 1000),
  }
  const computedEquity = policy.cash + positions.reduce((total, pos) => total + pos.quantity * pos.price, 0)
  if (!Number.isFinite(computedEquity) || Math.abs(computedEquity - policy.equity) > 0.01) throw new Error('Portfolio equity does not reconcile to cash plus the supplied signed holdings and prices.')
  if (policy.minCash > policy.equity) throw new Error('Minimum cash reserve exceeds equity.')
  return policy
}
export function validateFundDecisions(raw: unknown, policy: FundRiskPolicy) {
  if (!Array.isArray(raw) || raw.length > 200) throw new Error('Proposal decisions must be an array of at most 200 entries.')
  const byTicker = new Map(policy.positions.map((p) => [p.ticker, { ...p }]))
  const used = new Set<string>(), decisions: FundDecision[] = []
  let cash = policy.cash, fees = 0
  for (const value of raw) {
    const d = obj(value); if (!d) throw new Error('Invalid portfolio decision.')
    const symbol = ticker(d.ticker), pos = byTicker.get(symbol)
    if (!pos) throw new Error(`No user-supplied holding/quote for ${symbol}.`)
    if (used.has(symbol)) throw new Error(`Duplicate decision for ${symbol}; consolidate the order.`)
    used.add(symbol)
    const action = d.action as FundAction
    if (!['buy', 'sell', 'short', 'cover', 'hold'].includes(action)) throw new Error(`Invalid action for ${symbol}.`)
    const quantity = shares(d.quantity, `${symbol} proposed quantity`)
    if ((action === 'hold') !== (quantity === 0)) throw new Error('Hold requires zero quantity; other actions require a positive quantity.')
    if (action === 'buy' && pos.quantity < 0) throw new Error(`${symbol} has a short position; use cover.`)
    if (action === 'sell' && (pos.quantity <= 0 || quantity > pos.quantity)) throw new Error(`Cannot sell more ${symbol} shares than are held.`)
    if (action === 'cover' && (pos.quantity >= 0 || quantity > -pos.quantity)) throw new Error(`Cannot cover more ${symbol} shares than are short.`)
    if (action === 'short' && (!policy.allowShort || pos.quantity > 0 || pos.borrowLimitShares == null || quantity - pos.quantity > pos.borrowLimitShares)) throw new Error(`Shorting ${symbol} is not allowed by the policy, holdings, or borrow limit.`)
    const sign = action === 'buy' || action === 'cover' ? 1 : action === 'sell' || action === 'short' ? -1 : 0
    const cost = quantity * pos.price * policy.tradeCostBps / 10000
    cash -= sign * quantity * pos.price + cost; fees += cost
    pos.quantity += sign * quantity
    decisions.push({ ticker: symbol, action, quantity, reasoning: nonempty(d.reasoning, 'decision reasoning', 2000) })
  }
  const equity = policy.equity - fees
  if (equity <= 0 || !Number.isFinite(cash)) throw new Error('Proposal exhausts portfolio equity.')
  let grossExposure = 0, shortCollateral = 0
  const sectors = new Map<string, number>()
  for (const p of byTicker.values()) {
    const exposure = Math.abs(p.quantity * p.price)
    grossExposure += exposure
    sectors.set(p.sector.toLowerCase(), (sectors.get(p.sector.toLowerCase()) || 0) + exposure)
    if (p.quantity < 0) shortCollateral += exposure * policy.shortMarginPct / 100
    if (p.maxShares != null && Math.abs(p.quantity) > p.maxShares) throw new Error(`${p.ticker} exceeds its share cap.`)
    if (exposure > equity * policy.maxPositionPct / 100 + 1e-7) throw new Error(`${p.ticker} exceeds the position exposure cap.`)
  }
  if (cash - shortCollateral < policy.minCash - 1e-7) throw new Error('Proposed orders breach the minimum cash reserve after fees and short collateral.')
  if (grossExposure > equity * policy.maxGrossExposurePct / 100 + 1e-7) throw new Error('Proposed orders breach gross exposure limits.')
  for (const [sector, exposure] of sectors) if (exposure > equity * policy.maxSectorPct / 100 + 1e-7) throw new Error(`${sector} exceeds the sector exposure cap.`)
  return { decisions, cashAfter: cash, cashAvailableAfterCollateral: cash - shortCollateral, fees, equityAfterFees: equity, grossExposure, positionsAfter: [...byTicker.values()].map(({ ticker, quantity }) => ({ ticker, quantity })) }
}
export function hedgeFundOutputContract(role?: string): string {
  if (!role?.startsWith('hf-')) return ''
  const common = 'This is investment research, not brokerage execution. Named investor styles are simulated perspectives, not those people or independent specialist models. Confidence is qualitative and uncalibrated; never claim a probability of profit. Cite sources and dates for current facts. Missing evidence stays unknown.'
  if (role !== 'hf-portfolio') return common + (role === 'hf-risk' ? ' Suggested risk limits are advisory. Only a user-attached nalu-fund-risk-v1 JSON policy can establish actual cash, holdings, timestamped prices and enforced limits; never invent them.' : '')
  return common + ` OUTPUT ONLY JSON: {"schema":"nalu-fund-proposal-v1","summary":"research thesis, sources, dates, assumptions and uncertainties","decisions":[{"ticker":"AAPL","action":"buy|sell|short|cover|hold","quantity":0,"reasoning":"specific rationale"}]}. When no user-attached nalu-fund-risk-v1 policy is supplied, return decisions:[] and explain what portfolio inputs are missing in summary. Do not invent portfolio balances, quotes, limits or share quantities. With a policy, use only its tickers and prices; hold has quantity 0, other quantities are positive whole shares. All decisions will be checked together against cash, holdings, fees, borrowing and exposure limits. This is a proposal for review, never an executed trade.`
}
export function guardHedgeFundOutput(role: string | undefined, output: string, options: { policyText?: string; now?: number } = {}): string {
  if (!role?.startsWith('hf-')) return output
  if (role !== 'hf-risk' && role !== 'hf-portfolio') return `INVESTMENT RESEARCH — simulated perspective; confidence is uncalibrated.\n\n${output}`
  const policy = parseFundRiskPolicy(options.policyText, options.now)
  if (role === 'hf-risk') return `RISK RESEARCH — generated analysis is advisory; no trade has been executed.\n\n${output}\n\n${policy ? `USER POLICY: ${JSON.stringify({ schema: policy.schema, asOf: policy.asOf, currency: policy.currency, equity: policy.equity, cash: policy.cash, minCash: policy.minCash, maxPositionPct: policy.maxPositionPct, maxSectorPct: policy.maxSectorPct, maxGrossExposurePct: policy.maxGrossExposurePct, allowShort: policy.allowShort, shortMarginPct: policy.shortMarginPct })}` : 'NO PORTFOLIO POLICY: cash, holdings, quotes and enforceable limits have not been supplied. Downstream output must remain research-only with no trade quantities.'}`
  const proposal = obj(json(output))
  if (proposal?.schema !== 'nalu-fund-proposal-v1') throw new Error('Portfolio output does not match the required proposal schema.')
  const summary = nonempty(proposal.summary, 'research summary', 14000)
  if (!policy) {
    if (!Array.isArray(proposal.decisions) || proposal.decisions.length) throw new Error('Portfolio quantities require a user-attached, current nalu-fund-risk-v1 policy. No trades or quantities were accepted.')
    return JSON.stringify({ schema: 'nalu-fund-checked-v1', status: 'research-only', summary, decisions: [], execution: 'none', missing: ['User-supplied portfolio holdings, cash, timestamped quotes and risk policy'] }, null, 2)
  }
  const checked = validateFundDecisions(proposal.decisions, policy)
  return JSON.stringify({ schema: 'nalu-fund-checked-v1', status: 'proposal-within-user-limits', summary, ...checked, currency: policy.currency, policyAsOf: policy.asOf, execution: 'none', note: 'Arithmetic and limits checked against user-supplied data. Price accuracy, future returns, broker margin requirements and order execution are not established.' }, null, 2)
}
