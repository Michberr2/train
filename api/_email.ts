// Transactional email for Nalu (password resets, etc.) via Resend.
// Underscore-prefixed so Vercel does NOT treat it as a route — imported by the
// route handlers. Configure with two env vars:
//   RESEND_API_KEY   – your Resend API key (https://resend.com)
//   RESET_FROM       – the From address, e.g. "Nalu <noreply@n4lu.ai>"
//                      (its domain must be verified in Resend). Defaults to a
//                      no-reply on n4lu.ai.
// If RESEND_API_KEY is missing we return { ok:false, reason:'not-configured' }
// so callers can decide what to do (we never throw and never block the request).

export type SendResult = { ok: true } | { ok: false; reason: 'not-configured' | 'error'; detail?: string }

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY
}

export async function sendEmail(opts: { to: string; subject: string; html: string; text?: string }): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY
  if (!key) return { ok: false, reason: 'not-configured' }
  const from = process.env.RESET_FROM || 'Nalu <noreply@n4lu.ai>'
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        ...(opts.text ? { text: opts.text } : {}),
      }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { ok: false, reason: 'error', detail: detail.slice(0, 300) }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: 'error', detail: e instanceof Error ? e.message : 'send failed' }
  }
}

// The password-reset email body. Plain, on-brand, single clear CTA.
export function resetEmail(name: string, link: string): { subject: string; html: string; text: string } {
  const who = name ? name.split('@')[0] : 'there'
  const subject = 'Reset your Nalu password'
  const text =
    `Hi ${who},\n\n` +
    `We received a request to reset your Nalu password. Open this link to choose a new one (it expires in 1 hour):\n\n${link}\n\n` +
    `If you didn't request this, you can safely ignore this email — your password won't change.\n\n— Nalu`
  const html = `<!doctype html><html><body style="margin:0;background:#0b0e14;padding:32px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="440" cellpadding="0" cellspacing="0" style="max-width:440px;background:#12151d;border:1px solid #232a36;border-radius:16px;overflow:hidden">
      <tr><td style="padding:28px 28px 8px">
        <div style="color:#6B9FFF;font-size:12px;font-weight:700;letter-spacing:2px">NALU</div>
        <h1 style="color:#f4f6fa;font-size:20px;font-weight:600;margin:10px 0 0">Reset your password</h1>
      </td></tr>
      <tr><td style="padding:8px 28px 4px">
        <p style="color:#aeb6c4;font-size:14px;line-height:22px;margin:0">Hi ${who}, we got a request to reset your Nalu password. Choose a new one below — this link expires in <strong style="color:#f4f6fa">1 hour</strong>.</p>
      </td></tr>
      <tr><td style="padding:20px 28px 8px">
        <a href="${link}" style="display:inline-block;background:#6B9FFF;color:#0b0e14;font-size:15px;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:10px">Reset password</a>
      </td></tr>
      <tr><td style="padding:12px 28px 28px">
        <p style="color:#7b8494;font-size:12px;line-height:19px;margin:0">If the button doesn't work, paste this into your browser:<br><span style="color:#6B9FFF;word-break:break-all">${link}</span></p>
        <p style="color:#7b8494;font-size:12px;line-height:19px;margin:14px 0 0">Didn't request this? Ignore this email — your password won't change.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`
  return { subject, html, text }
}
