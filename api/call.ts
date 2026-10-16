import { connectionBackend } from './_connectionBackend'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareMessages } from './_cloudflareMessages'
// Place an OUTBOUND call — Nalu phones you (or any number you pass) and starts a
// two-way voice conversation (handled by api/phone.ts). Authed by Bearer token.
//
//   POST /api/call
//   { "message": "Your report is ready — want the highlights?", "to"?: "+1…", "voice"?: "britishWoman"|"britishMan" }
//
// If "to" is omitted, Nalu calls the phone number on the signed-in user's profile.
import { refineCallDraft } from './_callDraft'
import { searchCallRecipients } from './_callSearch'
import { readLocation } from './_placeContext'
import { handleOutboundAction } from './_outboundCalls'
import { OutboundError } from './_outboundBrief'
import { cors } from './_cors'
import { ownsPhone } from './_phoneOwner'
import { listTeam } from './_team'
import { ensureSchema, readToken, normalizePhone, safeJson } from './_db'
import { placeCall, publicBase, sign, phoneConfigured } from './_telephony'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }
  if (!phoneConfigured()) { res.status(501).json({ error: 'Phone calling is not configured (set TELNYX_API_KEY / TELNYX_ACCOUNT_SID / TELNYX_APPLICATION_SID / TELNYX_PUBLIC_KEY / TELNYX_PHONE_NUMBER).' }); return }

  const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body) || {}
  const message = String(body.message || '').trim().slice(0, 500) || 'Hello, this is Nalu calling.'
  const voice = String(body.voice || 'britishWoman') === 'britishMan' ? 'britishMan' : 'britishWoman'

  const backend=connectionBackend(),client=backend.client
  try {
    await backend.connect()
    if(!(client instanceof CloudflareStore))await ensureSchema(client as any)
    const userId = await backend.userId(readToken(req))
    if (!userId) { res.status(401).json({ error: 'not authenticated' }); return }

    if (!ownsPhone(userId)) return res.status(403).json({ error: 'This private Nalu number belongs to another account.' })
    if (body.action === 'recipient-refine') {
      const result = await refineCallDraft(body.draft, body.utterance, body.matches, body.timezone)
      res.status(200).json(result); return
    }
    if (body.action === 'recipient-search') {
      const result = await searchCallRecipients(body.query, body.area, await readLocation(client, userId))
      res.status(200).json(result); return
    }
    if (await handleOutboundAction(client, userId, body, res)) return
    const members = await listTeam(client, userId)
    const member = body.memberId ? members.find(m => m.active && m.id === body.memberId) : members[0]
    if (!member) return res.status(400).json({ error: 'Choose an active member of your team.' })

    // Only an omitted destination falls back to the profile. A malformed explicit
    // destination must never unexpectedly ring a different number.
    const profilePhone = normalizePhone(client instanceof CloudflareStore?await new CloudflareMessages(client).phone(userId):String((await client.query('SELECT phone FROM nalu_users WHERE id = $1', [userId])).rows[0]?.phone || ''))
    const explicitTo = Object.prototype.hasOwnProperty.call(body, 'to')
    const to = explicitTo ? normalizePhone(String(body.to || '')) : profilePhone
    if (!to) {
      res.status(400).json({ error: explicitTo
        ? 'Invalid destination phone number. Include its country code, e.g. +1 415 555 1234.'
        : 'No phone number to call. Add one to your profile or pass "to".' })
      return
    }

    if (to !== profilePhone) return res.status(400).json({ error: 'This private team line calls the phone number saved on your account.' })

    // Calling another recipient does not authorize them to use the caller's
    // account. Only a call to the account's own saved number gets that context.
    const uid = to === profilePhone ? userId : ''
    const expires = String(Date.now() + 10 * 60_000)
    const sig = sign([uid, message, to, expires, member.id].join('|'))
    const url = `${publicBase()}/api/phone?` + new URLSearchParams({
      step: 'outbound', voice, uid, msg: message, to, expires, sig, memberId: member.id,
    }).toString()

    const result = await placeCall(to, url)
    if (!result.ok) { res.status(502).json({ error: result.error || 'call failed' }); return }
    res.status(200).json({ ok: true, sid: result.sid, to })
  } catch (e) {
    res.status(e instanceof OutboundError ? e.status : 500).json({ error: e instanceof Error ? e.message.slice(0, 160) : 'call error' })
  } finally {
    await backend.close().catch(() => {})
  }
}
