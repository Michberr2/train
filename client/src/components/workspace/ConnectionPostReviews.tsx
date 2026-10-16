import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { connectionReviewStatus, getConnectionReview, listConnectionReviews, publishConnectionReview, type ConnectionReview, type TikTokReview } from '../../lib/connections'

const field = 'w-full rounded-xl border border-glass/20 bg-glass/[0.06] p-3 text-sm text-ink outline-none'
const button = 'rounded-xl border border-glass/20 px-3 py-2 text-sm disabled:opacity-40'
const privacyLabel: Record<string, string> = { PUBLIC_TO_EVERYONE: 'Everyone', MUTUAL_FOLLOW_FRIENDS: 'Friends', FOLLOWER_OF_CREATOR: 'Followers', SELF_ONLY: 'Only me' }

export default function ConnectionPostReviews() {
  const [items, setItems] = useState<ConnectionReview[]>([]), [selected, setSelected] = useState<ConnectionReview | null>(null)
  const [review, setReview] = useState<TikTokReview | null>(null), [title, setTitle] = useState(''), [privacy, setPrivacy] = useState('')
  const [duration, setDuration] = useState(0), [consent, setConsent] = useState(false)
  const [allowComments, setAllowComments] = useState(false), [allowDuet, setAllowDuet] = useState(false), [allowStitch, setAllowStitch] = useState(false)
  const [commercial, setCommercial] = useState(false), [ownBrand, setOwnBrand] = useState(false), [brandedContent, setBrandedContent] = useState(false)
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const load = useCallback(async () => { try { setItems(await listConnectionReviews()) } catch (e) { setError(e instanceof Error ? e.message : 'Could not load post reviews.') } }, [])
  useEffect(() => { void load() }, [load])
  // TikTok processing can outlive the request; poll its receipt without reuploading.
  useEffect(() => {
    const pending = items.filter(item => item.result?.ok && item.result.status === 'accepted')
    if (!pending.length) return
    let active = true
    const timer = setTimeout(async () => {
      for (const item of pending) {
        if (!active) return
        try {
          const result = await connectionReviewStatus(item.delivery_key)
          if (active) setItems(current => current.map(row => row.delivery_key === item.delivery_key ? { ...row, result } : row))
        } catch (e) { if (active) setError(e instanceof Error ? e.message : 'Could not check media processing.') }
      }
    }, 10000)
    return () => { active = false; clearTimeout(timer) }
  }, [items])
  const open = async (item: ConnectionReview) => {
    setBusy(item.delivery_key); setError(''); setNotice(''); setReview(null)
    setPrivacy(''); setConsent(false); setDuration(0); setCommercial(false); setOwnBrand(false); setBrandedContent(false)
    setAllowComments(false); setAllowDuet(false); setAllowStitch(false)
    try { const data = await getConnectionReview(item.delivery_key); setReview(data); setTitle(data.title); setSelected(item) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not open this post.') }
    finally { setBusy('') }
  }
  const publish = async () => {
    if (!selected || !review) return
    setBusy('publish'); setError('')
    try {
      const result = await publishConnectionReview(selected.delivery_key, title, { privacy, duration, consent, allowComments, allowDuet, allowStitch, commercial, ownBrand, brandedContent })
      if (!result.ok) { setError(result.detail); await load(); return }
      setNotice(`${result.detail}. Close Connections and resume the pipeline to continue.`)
      setSelected(null); setReview(null); await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Publishing could not be confirmed. Check the post status before retrying.') }
    finally { setBusy('') }
  }
  const allowed = review && duration > 0 && duration <= review.creator.max_video_post_duration_sec && !!privacy && consent && (!commercial || ownBrand || brandedContent) && !(commercial && brandedContent && privacy === 'SELF_ONLY')
  if (!items.length && !error) return null
  return <section className="mb-6 rounded-2xl border border-gold/25 bg-glass/[0.04] p-4">
    <h3 className="text-sm font-semibold">Publishing activity</h3>
    {error && <p role="alert" className="mt-3 text-sm text-red-400">{error} <button className="underline" onClick={() => void load()}>Refresh</button></p>}
    {notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
    {selected && review ? <div className="mt-3 space-y-4">
      <p className="text-sm">Posting to TikTok · {review.creator.creator_nickname || review.creator.creator_username || selected.label}</p>
      <video key={review.videoUrl} src={review.videoUrl} controls playsInline preload="metadata" className="mx-auto max-h-80 w-full rounded-xl bg-glass/10" onLoadedMetadata={e => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)} onError={() => setError('The saved video could not load. Reopen this review to refresh its preview.')} />
      <label className="block text-xs">Caption<textarea aria-label="TikTok caption" value={title} maxLength={2200} onChange={e => { setTitle(e.target.value); setConsent(false) }} className={`${field} mt-1 min-h-24`} /></label>
      <label className="block text-xs">Who can watch this video<select aria-label="TikTok privacy" value={privacy} onChange={e => { setPrivacy(e.target.value); setConsent(false) }} className={`${field} mt-1`}><option value="">Choose visibility</option>{review.creator.privacy_level_options.map(option => <option key={option} value={option} disabled={commercial && brandedContent && option === 'SELF_ONLY'}>{privacyLabel[option] || option}</option>)}</select></label>
      <fieldset className="flex flex-wrap gap-4 text-sm"><legend className="mb-2 text-xs">Allow people to</legend>
        <label><input type="checkbox" checked={allowComments} disabled={review.creator.comment_disabled} onChange={e => setAllowComments(e.target.checked)} /> Comment</label>
        <label><input type="checkbox" checked={allowDuet} disabled={review.creator.duet_disabled} onChange={e => setAllowDuet(e.target.checked)} /> Duet</label>
        <label><input type="checkbox" checked={allowStitch} disabled={review.creator.stitch_disabled} onChange={e => setAllowStitch(e.target.checked)} /> Stitch</label>
      </fieldset>
      <label className="block text-sm"><input type="checkbox" checked={commercial} onChange={e => { setCommercial(e.target.checked); setOwnBrand(false); setBrandedContent(false); setConsent(false) }} /> This video promotes a brand, product, or service</label>
      {commercial && <div className="space-y-2 rounded-xl border border-glass/15 p-3 text-sm"><label className="block"><input type="checkbox" checked={ownBrand} onChange={e => { setOwnBrand(e.target.checked); setConsent(false) }} /> Your brand</label><label className="block"><input type="checkbox" checked={brandedContent} onChange={e => { setBrandedContent(e.target.checked); setConsent(false); if (e.target.checked && privacy === 'SELF_ONLY') setPrivacy('') }} /> Branded content for another business</label><p className="text-xs text-dim">{brandedContent ? 'TikTok will label this as Paid partnership. Branded content must be visible to others.' : ownBrand ? 'TikTok will label this as Promotional content.' : 'Choose at least one disclosure.'}</p></div>}
      <label className="flex items-start gap-2 text-xs leading-relaxed"><input type="checkbox" className="mt-1" checked={consent} onChange={e => setConsent(e.target.checked)} /><span>I agree to upload this video with these settings and confirm TikTok’s <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer" className="underline">Music Usage Confirmation</a>{commercial && brandedContent && <> and <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer" className="underline">Branded Content Policy</a></>}</span></label>
      <p className="text-xs text-dim">{duration ? `${Math.ceil(duration)} seconds · Account limit ${review.creator.max_video_post_duration_sec} seconds` : 'Loading video duration…'}</p>
      <div className="flex justify-end gap-2"><button className={button} disabled={!!busy} onClick={() => { setSelected(null); setReview(null) }}>Keep draft</button><button className={`${button} flex items-center gap-2 bg-gold text-[#15170f]`} disabled={!allowed || !!busy} onClick={() => void publish()}>{busy === 'publish' && <Loader2 size={15} className="animate-spin" />}Publish to TikTok</button></div>
    </div> : <div className="mt-3 space-y-3">{items.map(item => <div key={item.delivery_key} className="flex items-start gap-3 border-t border-glass/10 pt-3"><div className="min-w-0 flex-1"><p className="break-words text-sm">{item.filename || 'Video post'} · {item.label}</p><p className="mt-1 text-xs text-dim">{item.result?.detail || 'Video saved. Your review is needed before publishing.'}</p></div>{!item.result ? <button disabled={!!busy} className={button} onClick={() => void open(item)}>{busy === item.delivery_key ? 'Loading…' : 'Review'}</button> : item.result.receipt && <button disabled={!!busy} className={button} onClick={async () => { setBusy(item.delivery_key); try { await connectionReviewStatus(item.delivery_key); await load() } catch (e) { setError(e instanceof Error ? e.message : 'Could not check status.') } finally { setBusy('') } }}>Check status</button>}</div>)}</div>}
  </section>
}
