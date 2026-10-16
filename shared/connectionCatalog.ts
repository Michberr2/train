export type ConnectionApp = {
  app: string; name: string; kind: 'email' | 'social' | 'chat' | 'work'; blurb: string; emoji: string
  provider?: string; tokenLabel?: string; destination?: 'channel' | 'subreddit' | 'repository' | 'page'
  requirement?: string
}

/** This inventory is shared by setup, verification and delivery. Every offered
 * app must have an actual adapter; arbitrary passwords are never integrations. */
export const CONNECTION_APPS: ConnectionApp[] = [
  { app: 'gmail', name: 'Gmail', provider: 'google', kind: 'email', blurb: 'Read mail and send from your Gmail account', emoji: '📧', tokenLabel: 'Google App Password' },
  { app: 'outlook', name: 'Outlook', provider: 'microsoft', kind: 'email', blurb: 'Read mail and send from Outlook or Microsoft 365', emoji: '📨', requirement: 'Use Microsoft sign-in to connect your mailbox.' },
  { app: 'linkedin', name: 'LinkedIn', provider: 'linkedin', kind: 'social', blurb: 'Publish updates to your LinkedIn profile', emoji: '💼', tokenLabel: 'LinkedIn access token' },
  { app: 'instagram', name: 'Instagram', provider: 'instagram', kind: 'social', blurb: 'Publish images and reels to your professional account', emoji: '📸', tokenLabel: 'Instagram access token', requirement: 'Requires a Business or Creator account and an image or video to publish.' },
  { app: 'x', name: 'X / Twitter', provider: 'x', kind: 'social', blurb: 'Publish posts to your X account', emoji: '𝕏', tokenLabel: 'OAuth user access token', requirement: 'Requires an X developer app with write access.' },
  { app: 'reddit', name: 'Reddit', provider: 'reddit', kind: 'social', blurb: 'Read and submit posts in your selected community', emoji: '👽', tokenLabel: 'Reddit OAuth access token', destination: 'subreddit' },
  { app: 'facebook', name: 'Facebook', provider: 'facebook', kind: 'social', blurb: 'Publish updates and photos to a Page you manage', emoji: '📘', tokenLabel: 'Facebook user access token', destination: 'page', requirement: 'Select a Facebook Page you manage.' },
  { app: 'tiktok', name: 'TikTok', provider: 'tiktok', kind: 'social', blurb: 'Publish videos with your chosen privacy settings', emoji: '🎵', tokenLabel: 'TikTok access token', requirement: 'Requires Content Posting access and a video from a verified domain.' },
  { app: 'slack', name: 'Slack', provider: 'slack', kind: 'chat', blurb: 'Read and post in a channel your app can access', emoji: '💬', tokenLabel: 'Slack bot token', destination: 'channel' },
  { app: 'github', name: 'GitHub', provider: 'github', kind: 'work', blurb: 'Read repository issues and create new issues', emoji: '⌘', tokenLabel: 'GitHub personal access token', destination: 'repository' },
  { app: 'webhook', name: 'Anything else', kind: 'work', blurb: 'Deliver work to your existing webhook or automation', emoji: '🔗', tokenLabel: 'Authorization token (optional)' },
]
export const connectionApp = (app: string) => CONNECTION_APPS.find(item => item.app === app)

export type ConnectionDestination = { id: string; name: string }
export type ConnectionMetadata = {
  destination?: string; destinationName?: string; accountId?: string; verifiedAt?: number
  detail?: string; privacy?: string; capabilities?: string[]
}

export function cleanConnectionMetadata(value: unknown): ConnectionMetadata {
  if (!value || typeof value !== 'object') return {}
  const input = value as Record<string, unknown>, result: Record<string, string> = {}
  // Only user-selected routing fields may be written by the client. Identity,
  // verification and capabilities always come from the provider.
  for (const key of ['destination', 'destinationName', 'privacy']) if (typeof input[key] === 'string') result[key] = input[key].trim().slice(0, 300)
  return result
}
