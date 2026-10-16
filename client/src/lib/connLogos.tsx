// Legit brand logos for Connections — official marks from simple-icons, rendered
// in each brand's real color. Near-black brands (X, TikTok, GitHub) render in the
// current text color so they stay visible on dark panels. Outlook's mark isn't in
// simple-icons (trademark), so we draw a clean Outlook-blue glyph; anything without
// a brand mark (generic "webhook") gets a neutral link icon.
import { siGmail, siLinkedin, siInstagram, siX, siReddit, siFacebook, siTiktok, siSlack, siGithub } from 'simple-icons'

type SI = { hex: string; path: string; title: string }
const MAP: Record<string, SI> = {
  gmail: siGmail, linkedin: siLinkedin, instagram: siInstagram, x: siX,
  reddit: siReddit, facebook: siFacebook, tiktok: siTiktok, slack: siSlack, github: siGithub,
}
const NEAR_BLACK = new Set(['x', 'tiktok', 'github'])

export function ConnLogo({ app, size = 18 }: { app: string; size?: number }) {
  if (app === 'outlook') {
    // Clean Outlook-blue mark: rounded square + white "O".
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Outlook">
        <rect x="1.5" y="4" width="21" height="16" rx="3" fill="#0A65C1" />
        <ellipse cx="8.4" cy="12" rx="3.5" ry="4" fill="none" stroke="#fff" strokeWidth="2" />
        <path d="M14 8.2 21.5 6v12L14 15.8z" fill="#0A65C1" stroke="#fff" strokeWidth="0.9" strokeLinejoin="round" />
      </svg>
    )
  }
  const ic = MAP[app]
  if (!ic) {
    // generic "anything else" connection
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Connection">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    )
  }
  const black = NEAR_BLACK.has(app)
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={black ? 'text-ink' : undefined} aria-label={ic.title}>
      <path d={ic.path} fill={black ? 'currentColor' : `#${ic.hex}`} />
    </svg>
  )
}
