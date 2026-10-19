import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, CreditCard, Heart, Loader2, RefreshCw } from 'lucide-react'
import { getToken } from '../../lib/localAuth'
import { BillingRequestError, clearBillingReturn, createBillingCheckout, getBillingReturn, getBillingSummary, verifyBillingPayment, type BillingSummary } from '../../lib/billing'

const money = (amountCents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amountCents / 100)
const focus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas'

function transactionDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
}

export default function AiBudgetPanel() {
  const token = useRef(getToken()).current
  const [billingReturn] = useState(getBillingReturn)
  const [summary, setSummary] = useState<BillingSummary | null>(null)
  const [amount, setAmount] = useState(2500)
  const [loading, setLoading] = useState(true)
  const [openingCheckout, setOpeningCheckout] = useState(false)
  const [supportAcknowledged, setSupportAcknowledged] = useState(false)
  const [checkoutCompleted, setCheckoutCompleted] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const alive = useRef(false)
  const loadRevision = useRef(0)
  const requestController = useRef<AbortController | null>(null)
  const checkoutController = useRef<AbortController | null>(null)
  const checkoutRequest = useRef<{ amount: number; id: string } | null>(null)
  const checkoutBusy = useRef(false)
  const paymentConfirmed = useRef(false)

  const refresh = useCallback(async () => {
    requestController.current?.abort()
    const controller = new AbortController()
    requestController.current = controller
    const revision = ++loadRevision.current
    const current = () => alive.current && revision === loadRevision.current && token === getToken() && !controller.signal.aborted
    setLoading(true)
    setError('')
    try {
      const support = await getBillingSummary(token, controller.signal)
      if (!current()) return
      setSummary(support)
      setAmount(previous => support.packs.some(pack => pack.amountCents === previous) ? previous : (support.packs[0]?.amountCents ?? 2500))
      if (billingReturn?.status === 'success' && !paymentConfirmed.current) {
        if (!billingReturn.sessionId) throw new Error('This payment link is incomplete. Check your tip history or contact support if a payment is missing.')
        setNotice('Checking your payment…')
        const verified = await verifyBillingPayment(billingReturn.sessionId, token, controller.signal)
        if (!current()) return
        setSummary(verified)
        if (verified.paymentStatus === 'paid') {
          paymentConfirmed.current = true
          setConfirmed(true)
          setNotice(verified.refundedCents ? 'This payment was confirmed and has a refund. Your tip history is up to date.' : 'Payment confirmed. Thank you for supporting Nalu.')
          clearBillingReturn()
        } else {
          setNotice('Your payment is still processing. Check again shortly; confirmed payments will appear in your tip history.')
        }
      } else if (billingReturn?.status === 'cancel') {
        setNotice('You returned from checkout. Your tip history is up to date.')
        clearBillingReturn()
      }
    } catch (failure) {
      if (!current()) return
      setError(failure instanceof Error ? failure.message : 'Your support history could not be loaded. Please try again.')
      if (!paymentConfirmed.current) setNotice('')
    } finally {
      if (current()) setLoading(false)
    }
  }, [billingReturn, token])

  useEffect(() => {
    alive.current = true
    void refresh()
    return () => {
      alive.current = false
      requestController.current?.abort()
      checkoutController.current?.abort()
      loadRevision.current++
    }
  }, [refresh])

  const contribute = async () => {
    if (checkoutBusy.current || checkoutCompleted || loading || !summary?.checkoutEnabled || !supportAcknowledged || token !== getToken()) return
    checkoutBusy.current = true
    setOpeningCheckout(true)
    setError('')
    const controller = new AbortController()
    checkoutController.current = controller
    try {
      // Reuse this key after a network failure, so a retry opens the same checkout.
      if (checkoutRequest.current?.amount !== amount) checkoutRequest.current = { amount, id: crypto.randomUUID() }
      const checkout = await createBillingCheckout(amount, checkoutRequest.current.id, supportAcknowledged, token, controller.signal)
      if (!alive.current || token !== getToken() || controller.signal.aborted) return
      window.location.assign(checkout.url)
    } catch (failure) {
      if (!alive.current || token !== getToken() || controller.signal.aborted) return
      if (failure instanceof BillingRequestError && failure.code === 'checkout_expired') {
        checkoutRequest.current = null
        setError('That checkout expired. Choose Support Nalu again to open a new one.')
      } else if (failure instanceof BillingRequestError && failure.code === 'checkout_completed') {
        setCheckoutCompleted(true)
        await refresh()
        if (alive.current && token === getToken() && !controller.signal.aborted) {
          setNotice('This checkout is already complete. Your payment may still be processing. Review your tip history before starting another payment.')
        }
      } else {
        setError(failure instanceof Error ? failure.message : 'Checkout could not be opened. Please try again.')
      }
    } finally {
      checkoutBusy.current = false
      if (alive.current && token === getToken()) setOpeningCheckout(false)
    }
  }

  const disabled = loading || openingCheckout || checkoutCompleted || !summary?.checkoutEnabled || !summary.packs.some(pack => pack.amountCents === amount)

  return (
    <section aria-labelledby="support-nalu-heading" aria-busy={loading}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Heart size={15} className="text-dim" aria-hidden="true" />
          <h2 id="support-nalu-heading" className="text-sm font-semibold text-ink">Support Nalu</h2>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading || openingCheckout}
          className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs text-ink hover:bg-glass/10 disabled:opacity-50 ${focus}`}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          {loading ? 'Checking…' : 'Refresh history'}
        </button>
      </div>

      <div className="space-y-5 rounded-xl border border-glass/[0.18] bg-glass/[0.11] px-5 py-5 backdrop-blur-2xl">
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-dim">Your total tips</p>
            {summary?.mode === 'test' && <span className="rounded-full border border-glass/20 px-2.5 py-1 text-xs text-ink">Test mode</span>}
          </div>
          <p className="mt-2 flex items-baseline gap-2"><span className="text-4xl font-medium tracking-tight tabular-nums">{summary ? money(summary.supportedAmountCents) : '—'}</span><span className="text-xs text-dim">USD</span></p>
          <p className="mt-1 text-xs text-dim">Total tips, less any refunds.</p>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-dim">Leave an optional, one-time tip for Nalu assistance you’ve received.</p>
          <p className="mt-2 max-w-lg text-xs leading-relaxed text-dim">Tips help cover operating costs and add no credits, features, or guaranteed future access.</p>
        </div>

        {summary?.mode === 'test' && <p className="rounded-lg border border-glass/15 bg-glass/5 px-3 py-2.5 text-xs leading-relaxed text-ink">Test payments only. No real money is charged. Test tips are separate from your real payments.</p>}
        {summary && !summary.tipEligible && <p className="rounded-lg border border-glass/15 bg-glass/5 px-3 py-2.5 text-sm leading-relaxed text-ink">Use Nalu first: send a message and receive assistance in a saved chat. You can return here to leave an optional tip afterward.</p>}
        {summary?.tipEligible && !summary.checkoutEnabled && <p className="rounded-lg border border-glass/15 bg-glass/5 px-3 py-2.5 text-sm leading-relaxed text-ink">Payments aren’t available yet. You’ll be able to leave a tip here when checkout is ready.</p>}

        <fieldset disabled={disabled}>
          <legend className="mb-2 text-xs text-dim">Choose an amount</legend>
          <div className="grid grid-cols-3 gap-2">
            {(summary?.packs.length ? summary.packs : [{ amountCents: 1000 }, { amountCents: 2500 }, { amountCents: 5000 }]).map(pack => (
              <label key={pack.amountCents} className={`relative flex min-h-12 items-center justify-center gap-1.5 rounded-xl border px-3 py-3 text-sm transition-colors focus-within:ring-2 focus-within:ring-accent ${amount === pack.amountCents ? 'border-ink bg-glass/10 text-ink' : 'border-glass/20 text-dim hover:bg-glass/5'} ${disabled ? 'cursor-default opacity-50' : 'cursor-pointer'}`}>
                <input type="radio" name="support-nalu-amount" value={pack.amountCents} checked={amount === pack.amountCents} onChange={() => setAmount(pack.amountCents)} className="sr-only" />
                {amount === pack.amountCents && <Check size={13} aria-hidden="true" />}{money(pack.amountCents).replace('.00', '')}
              </label>
            ))}
          </div>
        </fieldset>

        <label className={`flex items-start gap-2.5 text-xs leading-relaxed text-dim ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
          <input type="checkbox" checked={supportAcknowledged} onChange={event => setSupportAcknowledged(event.target.checked)} disabled={disabled}
            className={`mt-0.5 h-4 w-4 shrink-0 accent-ink ${focus}`} />
          <span>I understand this is an optional tip for Nalu assistance I’ve already received. It does not buy usage credits, a subscription, or additional access.</span>
        </label>

        <div>
          <button type="button" onClick={() => void contribute()} disabled={disabled || !supportAcknowledged}
            className={`flex w-full items-center justify-center gap-2 rounded-xl bg-ink px-4 py-3 text-sm text-panel transition-opacity hover:opacity-90 disabled:opacity-40 ${focus}`}>
            {openingCheckout ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <CreditCard size={16} aria-hidden="true" />}
            {openingCheckout ? 'Opening checkout…' : `Support Nalu with ${money(amount).replace('.00', '')}${summary?.mode === 'test' ? ' · test' : ''}`}
            {!openingCheckout && <ArrowUpRight size={15} aria-hidden="true" />}
          </button>
          <p className="mt-2 text-center text-xs leading-relaxed text-dim">Secure checkout with Stripe. One-time payment. No subscription or recurring charges.</p>
          <p className="mt-2 text-center text-xs leading-relaxed text-dim"><a href="/payment-info.html" target="_blank" rel="noopener noreferrer" className={`underline underline-offset-2 ${focus}`}>Payment information and refunds</a> · <a href="/privacy.html" target="_blank" rel="noopener noreferrer" className={`underline underline-offset-2 ${focus}`}>Privacy policy</a></p>
        </div>

        {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2.5 text-sm leading-relaxed text-ink">{error}</div>}
        {notice && <div role="status" className="flex items-start gap-2 rounded-lg border border-glass/15 bg-glass/5 px-3 py-2.5 text-sm leading-relaxed text-ink">{confirmed && <Check size={16} className="mt-0.5 shrink-0" aria-hidden="true" />}<span>{notice}</span></div>}
        {checkoutCompleted && <button type="button" disabled={loading || openingCheckout} onClick={() => {
          checkoutRequest.current = null
          setCheckoutCompleted(false)
          setNotice('Choose an amount to start another payment.')
        }} className={`rounded-lg border border-glass/20 px-3 py-2 text-sm text-ink hover:bg-glass/10 disabled:opacity-50 ${focus}`}>Start another payment</button>}
      </div>

      <div className="mt-5 rounded-xl border border-glass/[0.18] bg-glass/[0.11] px-5 py-4 backdrop-blur-2xl">
        <h3 className="mb-3 text-sm font-medium text-ink">Tip history</h3>
        {summary?.transactions.length ? (
          <ul className="divide-y divide-glass/10">
            {summary.transactions.map(transaction => (
              <li key={transaction.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0"><p className="break-words text-sm text-ink">{transaction.description || 'Tip payment update'}</p><p className="mt-1 text-xs text-dim">{transactionDate(transaction.createdAt)}</p></div>
                <span className="shrink-0 text-sm tabular-nums text-ink">{transaction.amountCents > 0 ? '+' : ''}{money(transaction.amountCents)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm leading-relaxed text-dim">{loading ? 'Loading your history…' : summary ? 'Your tips and any refunds will appear here.' : 'Refresh to load your tip history.'}</p>}
      </div>
    </section>
  )
}
