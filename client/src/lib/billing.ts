import { getToken } from './localAuth'

export interface BillingTransaction {
  id: string
  kind: string
  amountCents: number
  createdAt: string
  description: string
}

export interface BillingSummary {
  currency: 'usd'
  paymentPurpose: 'support'
  supportedAmountCents: number
  mode: 'test' | 'live' | 'unconfigured'
  checkoutEnabled: boolean
  tipEligible: boolean
  packs: { amountCents: number }[]
  transactions: BillingTransaction[]
}

export interface VerifiedPayment extends BillingSummary {
  paymentStatus: 'paid' | 'pending'
  contributedCents?: number
  refundedCents?: number
}

export type BillingReturn = { status: 'success' | 'cancel'; sessionId: string | null }

export class BillingRequestError extends Error {
  constructor(message: string, readonly code: string | undefined) {
    super(message)
    this.name = 'BillingRequestError'
  }
}

export function getBillingReturn(): BillingReturn | null {
  const params = new URLSearchParams(window.location.search)
  const status = params.get('billing')
  if (status !== 'success' && status !== 'cancel') return null
  return { status, sessionId: params.get('session_id') }
}

export function clearBillingReturn(): void {
  const url = new URL(window.location.href)
  url.searchParams.delete('billing')
  url.searchParams.delete('session_id')
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function cents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function summary(value: unknown): BillingSummary {
  const body = record(value)
  if (body.currency !== 'usd' || body.paymentPurpose !== 'support'
    || !cents(body.supportedAmountCents) || body.supportedAmountCents < 0
    || !['test', 'live', 'unconfigured'].includes(String(body.mode))
    || typeof body.checkoutEnabled !== 'boolean' || typeof body.tipEligible !== 'boolean' || !Array.isArray(body.packs)
    || !Array.isArray(body.transactions)) {
    throw new Error('Your support history could not be loaded. Please try again.')
  }
  const packs = body.packs.map(record).filter(pack => cents(pack.amountCents) && [1000, 2500, 5000].includes(pack.amountCents))
    .map(pack => ({ amountCents: pack.amountCents as number }))
  const transactions = body.transactions.map(record).filter(transaction =>
    typeof transaction.id === 'string' && typeof transaction.kind === 'string'
    && cents(transaction.amountCents) && typeof transaction.createdAt === 'string'
    && typeof transaction.description === 'string',
  ).map(transaction => transaction as unknown as BillingTransaction)
  return { ...body, checkoutEnabled: body.checkoutEnabled && body.tipEligible, packs, transactions } as unknown as BillingSummary
}

async function request(payload: Record<string, unknown> | null, token: string | null, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!token || token !== getToken()) throw new Error('Please sign in again to view your support history.')
  let response: Response
  try {
    response = await fetch('/api/billing', {
      method: payload ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      cache: 'no-store',
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error('We could not connect. Please try again.')
  }
  const body = record(await response.json().catch(() => null))
  if (token !== getToken()) throw new Error('Your account changed. Please sign in again to view your support history.')
  if (!response.ok || body.ok === false) {
    throw new BillingRequestError(
      typeof body.error === 'string' ? body.error : 'Your payment information is unavailable. Please try again.',
      typeof body.code === 'string' ? body.code : undefined,
    )
  }
  return body
}

export async function getBillingSummary(token: string | null, signal?: AbortSignal): Promise<BillingSummary> {
  return summary(await request(null, token, signal))
}

export async function createBillingCheckout(amountCents: number, requestId: string, supportAcknowledged: boolean, token: string | null, signal?: AbortSignal): Promise<{ url: string; sessionId: string }> {
  if (!supportAcknowledged) throw new Error('Confirm that this payment is an optional tip before continuing.')
  const body = await request({ action: 'checkout', amountCents, requestId, supportAcknowledged }, token, signal)
  if (typeof body.url !== 'string' || typeof body.sessionId !== 'string') throw new Error('Checkout could not be opened. Please try again.')
  const url = new URL(body.url)
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.username || url.password) {
    throw new Error('Checkout could not be opened. Please try again.')
  }
  return { url: url.href, sessionId: body.sessionId }
}

export async function verifyBillingPayment(sessionId: string, token: string | null, signal?: AbortSignal): Promise<VerifiedPayment> {
  const body = await request({ action: 'verify', sessionId }, token, signal)
  if (body.paymentStatus !== 'paid' && body.paymentStatus !== 'pending') throw new Error('Payment is not confirmed yet. Please check again.')
  return {
    ...summary(body),
    paymentStatus: body.paymentStatus,
    ...(cents(body.contributedCents) ? { contributedCents: body.contributedCents } : {}),
    ...(cents(body.refundedCents) ? { refundedCents: body.refundedCents } : {}),
  }
}
