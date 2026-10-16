import { META_VERSION } from './_oauthProviders'
import { connectionApp, type ConnectionDestination, type ConnectionMetadata } from '../shared/connectionCatalog'

export type ProviderContext = { app: string; token: string; username?: string; meta: ConnectionMetadata; signal?: AbortSignal }
export type ProviderIdentity = { username: string; accountId: string; capabilities: string[] }
export type ProviderDelivery = { ok: boolean; detail: string; receipt?: string; status?: 'accepted' | 'published' }
export class ConnectionProviderError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message) }
}
const segment = (s: string) => encodeURIComponent(s)
const githubHeaders = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' }
const socialText = (p: Record<string, unknown>) => String(p.text || p.body || p.caption || '').trim()
const required = (v: unknown, label: string) => { const value = typeof v === 'string' ? v.trim() : ''; if (!value) throw new Error(label); return value }
const mediaUrl = (value: unknown) => {
  const source = required(value, 'This platform needs an image or video. Add media to the post before publishing.')
  let url: URL
  try { url = new URL(source) } catch { throw new Error('Use a publicly accessible HTTPS media URL.') }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use a publicly accessible HTTPS media URL.')
  return source
}

/** A 200 response can still be a rejected Slack, Reddit or TikTok operation. */
export async function providerJson(ctx: ProviderContext, url: string, options: RequestInit = {}): Promise<{ body: any; response: Response }> {
  const signals = [AbortSignal.timeout(20000), ctx.signal, options.signal].filter(Boolean) as AbortSignal[]
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json', 'User-Agent': 'Nalu/1.0 (https://n4lu.ai)', ...options.headers }, signal: AbortSignal.any(signals) })
  const body = await response.json().catch(() => ({})) as any
  const rawCode = typeof body.error === 'string' ? body.error : body.error?.code || body.json?.errors?.[0]?.[0] || (body.errors?.length ? body.errors[0]?.type || 'request_error' : '')
  const errorCode = rawCode && rawCode !== 'ok' ? String(rawCode) : ''
  if (!response.ok || body.ok === false || errorCode) {
    const code = /^[\w.-]{1,80}$/.test(errorCode) ? errorCode : String(response.status)
    const auth = response.status === 401 || ['invalid_auth', 'token_expired', 'invalid_token', '190'].includes(code)
    const action = auth ? 'Reconnect this account to renew access.' : response.status === 403 ? 'Check the app permissions and the selected destination.' : response.status === 429 ? 'The provider rate limit was reached. Try again later.' : 'Check the connection and the provider requirements before trying again.'
    throw new ConnectionProviderError(`${connectionApp(ctx.app)?.name || ctx.app} rejected the request (${code}). ${action}`, auth ? 401 : response.status, code)
  }
  return { body, response }
}
const jsonPost = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const formPost = (body: Record<string, string>): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() })

export async function tiktokCreator(ctx: ProviderContext): Promise<Record<string, any>> {
  if (ctx.app !== 'tiktok') throw new Error('Select a TikTok connection.')
  const { body } = await providerJson(ctx, 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/', jsonPost({}))
  if (!Array.isArray(body.data?.privacy_level_options) || !Number(body.data?.max_video_post_duration_sec)) throw new Error('TikTok did not return posting permissions. Reconnect the account.')
  return body.data
}
export async function tiktokPostStatus(ctx: ProviderContext, receipt: string): Promise<Record<string, any>> {
  if (ctx.app !== 'tiktok' || !receipt || receipt.length > 500) throw new Error('Invalid TikTok post receipt.')
  const { body } = await providerJson(ctx, 'https://open.tiktokapis.com/v2/post/publish/status/fetch/', jsonPost({ publish_id: receipt }))
  return body.data || {}
}
export async function instagramProcessingStatus(ctx: ProviderContext, receipt: string): Promise<string> {
  if (ctx.app !== 'instagram' || !receipt || receipt.length > 500) throw new Error('Invalid Instagram media receipt.')
  const { body } = await providerJson(ctx, `https://graph.instagram.com/${META_VERSION()}/${segment(receipt)}?fields=status_code`)
  return String(body.status_code || '')
}
export async function publishInstagramContainer(ctx: ProviderContext, receipt: string): Promise<ProviderDelivery> {
  const account = required(ctx.meta.accountId, 'Reconnect Instagram.')
  const { body } = await providerJson(ctx, `https://graph.instagram.com/${META_VERSION()}/${segment(account)}/media_publish`, formPost({ creation_id: receipt }))
  return { ok: true, detail: 'Published to Instagram', receipt: required(body.id, 'Instagram did not confirm the post.'), status: 'published' }
}

/** Verifies access with a read-only profile request; never sends a test message. */
export async function verifyProvider(ctx: ProviderContext): Promise<ProviderIdentity> {
  let body: any
  if (ctx.app === 'gmail') {
    ;({ body } = await providerJson(ctx, 'https://gmail.googleapis.com/gmail/v1/users/me/profile'))
    return { username: required(body.emailAddress, 'Gmail did not return your email address.'), accountId: body.emailAddress, capabilities: ['email', 'inbox'] }
  }
  if (ctx.app === 'outlook') {
    ;({ body } = await providerJson(ctx, 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName'))
    return { username: required(body.mail || body.userPrincipalName, 'Outlook did not return your email address.'), accountId: required(body.id, 'Outlook identity is missing.'), capabilities: ['email', 'inbox'] }
  }
  if (ctx.app === 'linkedin') {
    ;({ body } = await providerJson(ctx, 'https://api.linkedin.com/v2/userinfo'))
    return { username: required(body.name || body.sub, 'LinkedIn identity is missing.'), accountId: required(body.sub, 'LinkedIn profile access was not granted.'), capabilities: ['post'] }
  }
  if (ctx.app === 'x') {
    ;({ body } = await providerJson(ctx, 'https://api.x.com/2/users/me'))
    return { username: required(body.data?.username, 'X identity is missing.'), accountId: required(body.data?.id, 'X identity is missing.'), capabilities: ['post', 'inbox'] }
  }
  if (ctx.app === 'reddit') {
    ;({ body } = await providerJson(ctx, 'https://oauth.reddit.com/api/v1/me'))
    return { username: required(body.name, 'Reddit identity is missing.'), accountId: required(body.id, 'Reddit identity is missing.'), capabilities: ['post', 'inbox'] }
  }
  if (ctx.app === 'slack') {
    ;({ body } = await providerJson(ctx, 'https://slack.com/api/auth.test', { method: 'POST' }))
    return { username: required(body.team || body.user, 'Slack identity is missing.'), accountId: required(body.user_id, 'Slack identity is missing.'), capabilities: ['post', 'inbox'] }
  }
  if (ctx.app === 'github') {
    ;({ body } = await providerJson(ctx, 'https://api.github.com/user', { headers: githubHeaders }))
    return { username: required(body.login, 'GitHub identity is missing.'), accountId: required(String(body.id || ''), 'GitHub identity is missing.'), capabilities: ['issue', 'inbox'] }
  }
  if (ctx.app === 'instagram') {
    ;({ body } = await providerJson(ctx, `https://graph.instagram.com/${META_VERSION()}/me?fields=user_id,username`))
    return { username: required(body.username, 'Instagram professional account access is missing.'), accountId: required(String(body.user_id || body.id || ''), 'Instagram identity is missing.'), capabilities: ['image', 'video', 'inbox'] }
  }
  if (ctx.app === 'facebook') {
    ;({ body } = await providerJson(ctx, `https://graph.facebook.com/${META_VERSION()}/me?fields=id,name`))
    return { username: required(body.name, 'Facebook identity is missing.'), accountId: required(body.id, 'Facebook identity is missing.'), capabilities: ['post', 'image', 'inbox'] }
  }
  if (ctx.app === 'tiktok') {
    ;({ body } = await providerJson(ctx, 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name'))
    return { username: required(body.data?.user?.display_name, 'TikTok identity is missing.'), accountId: required(body.data?.user?.open_id, 'TikTok identity is missing.'), capabilities: ['video', 'inbox'] }
  }
  throw new Error('This app does not have a supported account connection.')
}

export async function providerDestinations(ctx: ProviderContext, cursor = ''): Promise<{ items: ConnectionDestination[]; nextCursor?: string }> {
  if (ctx.app === 'slack') {
    const params = new URLSearchParams({ types: 'public_channel,private_channel', exclude_archived: 'true', limit: '100', ...(cursor ? { cursor } : {}) })
    const { body } = await providerJson(ctx, `https://slack.com/api/conversations.list?${params}`)
    return { items: (body.channels || []).map((c: any) => ({ id: String(c.id), name: `#${c.name}` })), nextCursor: body.response_metadata?.next_cursor || undefined }
  }
  if (ctx.app === 'github') {
    const page = /^\d+$/.test(cursor) ? Math.min(10000, Math.max(1, Number(cursor))) : 1
    const { body, response } = await providerJson(ctx, `https://api.github.com/user/repos?per_page=100&sort=updated&page=${page}`, { headers: githubHeaders })
    return { items: (Array.isArray(body) ? body : []).filter((r: any) => r.has_issues && !r.archived).map((r: any) => ({ id: String(r.full_name), name: String(r.full_name) })), nextCursor: /rel="next"/.test(response.headers.get('link') || '') ? String(page + 1) : undefined }
  }
  if (ctx.app === 'facebook') {
    const params = new URLSearchParams({ fields: 'id,name', limit: '100', ...(cursor ? { after: cursor } : {}) })
    const { body } = await providerJson(ctx, `https://graph.facebook.com/${META_VERSION()}/me/accounts?${params}`)
    return { items: (body.data || []).map((page: any) => ({ id: String(page.id), name: String(page.name) })), nextCursor: body.paging?.next ? body.paging?.cursors?.after : undefined }
  }
  if (ctx.app === 'reddit') {
    const params = new URLSearchParams({ limit: '100', ...(cursor ? { after: cursor } : {}) })
    const { body } = await providerJson(ctx, `https://oauth.reddit.com/subreddits/mine/subscriber?${params}`)
    return { items: (body.data?.children || []).map((item: any) => ({ id: String(item.data.display_name), name: `r/${item.data.display_name}` })), nextCursor: body.data?.after || undefined }
  }
  return { items: [] }
}

/** Validate the selected destination using the provider's own access control. */
export async function verifyDestination(ctx: ProviderContext): Promise<string | undefined> {
  const destination = ctx.meta.destination
  if (!connectionApp(ctx.app)?.destination) return undefined
  if (!destination) throw new Error(`Choose a ${connectionApp(ctx.app)!.destination} for this connection.`)
  if (ctx.app === 'slack') {
    const { body } = await providerJson(ctx, `https://slack.com/api/conversations.info?channel=${segment(destination)}`)
    if (body.channel?.is_archived || body.channel?.is_member === false) throw new Error('Invite the Slack app to this channel before connecting it.')
    return `#${required(body.channel?.name, 'Slack channel was not found.')}`
  }
  if (ctx.app === 'github') {
    if (!/^[\w.-]+\/[\w.-]+$/.test(destination)) throw new Error('Choose a repository in owner/repository format.')
    const { body } = await providerJson(ctx, `https://api.github.com/repos/${destination}`, { headers: githubHeaders })
    if (body.archived || !body.has_issues) throw new Error('Choose an active repository with issues enabled.')
    return required(body.full_name, 'GitHub repository was not found.')
  }
  if (ctx.app === 'reddit') {
    if (!/^[A-Za-z0-9_]{2,50}$/.test(destination)) throw new Error('Enter the subreddit name without r/.')
    const { body } = await providerJson(ctx, `https://oauth.reddit.com/r/${destination}/about`)
    if (!body.data?.display_name) throw new Error('That Reddit community is unavailable.')
    return `r/${body.data.display_name}`
  }
  if (ctx.app === 'facebook') {
    const { body } = await providerJson(ctx, `https://graph.facebook.com/${META_VERSION()}/${segment(destination)}?fields=id,name,access_token`)
    if (!body.access_token) throw new Error('You do not have publishing access to this Facebook Page.')
    return required(body.name, 'Facebook Page was not found.')
  }
}

export function validateTikTokReview(creator: { data: Record<string, any> }, review: Record<string, unknown>): string {
    const privacy = required(review.privacy, 'Choose a TikTok privacy setting before publishing.')
    if (!creator.data?.privacy_level_options?.includes(privacy)) throw new Error('This privacy setting is not available for your TikTok account. Update the connection settings.')
    const duration = Number(review.duration)
    if (!(duration > 0) || duration > Number(creator.data.max_video_post_duration_sec || 0)) throw new Error('Check the video duration against this TikTok account’s publishing limit.')
    if (review.commercial === true && !review.ownBrand && !review.brandedContent) throw new Error('Choose whether the video promotes your brand or another brand.')
    if (review.brandedContent === true && privacy === 'SELF_ONLY') throw new Error('Branded content cannot use TikTok’s private visibility setting.')
    return privacy
}

export async function publishProvider(ctx: ProviderContext, kind: string, payload: Record<string, unknown>): Promise<ProviderDelivery> {
  const text = socialText(payload), destination = ctx.meta.destination
  if (kind !== 'email' && payload.videoUrl && !['instagram', 'tiktok'].includes(ctx.app)) throw new Error('This connection cannot publish videos. Choose Instagram, TikTok, or a video publishing webhook.')
  if (kind === 'email') {
    if (!['gmail', 'outlook'].includes(ctx.app)) throw new Error('Choose a Gmail or Outlook connection for an email step.')
    const to = required(payload.to, 'Add an email recipient.'), subject = String(payload.subject || 'From Nalu')
    if (/[\r\n]/.test(to + subject)) throw new Error('The email destination or subject is invalid.')
    if (!text && !payload.html) throw new Error('The email has no content.')
    if (ctx.app === 'gmail') {
      const raw = Buffer.from(`To: ${to}\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\nMIME-Version: 1.0\r\nContent-Type: ${payload.html ? 'text/html' : 'text/plain'}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(String(payload.html || text)).toString('base64').match(/.{1,76}/g)?.join('\r\n') || ''}`).toString('base64url')
      const { body } = await providerJson(ctx, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', jsonPost({ raw }))
      return { ok: true, detail: `Sent from Gmail to ${to}`, receipt: required(body.id, 'Gmail did not confirm message acceptance.'), status: 'accepted' }
    }
    await providerJson(ctx, 'https://graph.microsoft.com/v1.0/me/sendMail', jsonPost({ message: { subject, body: { contentType: payload.html ? 'HTML' : 'Text', content: String(payload.html || text) }, toRecipients: to.split(/[;,]/).map(address => ({ emailAddress: { address: address.trim() } })) } }))
    return { ok: true, detail: `Accepted by Outlook for ${to}`, status: 'accepted' }
  }
  if (!text && !payload.videoUrl && !payload.image) throw new Error('Add content before publishing.')
  if (ctx.app === 'linkedin') {
    const author = `urn:li:person:${required(ctx.meta.accountId, 'Reconnect LinkedIn to load your profile.')}`
    const { response } = await providerJson(ctx, 'https://api.linkedin.com/rest/posts', { ...jsonPost({ author, commentary: text, visibility: 'PUBLIC', distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false }), headers: { 'Content-Type': 'application/json', 'Linkedin-Version': process.env.LINKEDIN_API_VERSION || '202603', 'X-Restli-Protocol-Version': '2.0.0' } })
    return { ok: true, detail: 'Published to LinkedIn', receipt: required(response.headers.get('x-restli-id'), 'LinkedIn did not confirm the post ID.'), status: 'published' }
  }
  if (ctx.app === 'x') {
    const { body } = await providerJson(ctx, 'https://api.x.com/2/tweets', jsonPost({ text }))
    return { ok: true, detail: 'Published to X', receipt: required(body.data?.id, 'X did not confirm the post ID.'), status: 'published' }
  }
  if (ctx.app === 'slack') {
    const { body } = await providerJson(ctx, 'https://slack.com/api/chat.postMessage', jsonPost({ channel: required(destination, 'Choose a Slack channel.'), text, unfurl_links: false, unfurl_media: false }))
    return { ok: true, detail: `Posted to ${ctx.meta.destinationName || 'Slack'}`, receipt: required(body.ts, 'Slack did not confirm the message.'), status: 'published' }
  }
  if (ctx.app === 'github') {
    const repo = required(destination, 'Choose a GitHub repository.')
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Choose a valid GitHub repository.')
    const title = required(payload.title || payload.subject || text.split('\n')[0], 'Add an issue title.')
    if (title.length > 256) throw new Error('Use an issue title of 256 characters or fewer.')
    const { body } = await providerJson(ctx, `https://api.github.com/repos/${repo}/issues`, { ...jsonPost({ title, body: text }), headers: { ...githubHeaders, 'Content-Type': 'application/json' } })
    return { ok: true, detail: `Created issue in ${repo}`, receipt: required(body.html_url, 'GitHub did not confirm the issue.'), status: 'published' }
  }
  if (ctx.app === 'reddit') {
    const subreddit = required(destination, 'Choose a Reddit community.')
    if (!/^[A-Za-z0-9_]{2,50}$/.test(subreddit)) throw new Error('Use a valid subreddit name.')
    const title = required(payload.title || payload.subject || text.split('\n')[0], 'Add a Reddit post title.')
    if (title.length > 300) throw new Error('Use a Reddit title of 300 characters or fewer.')
    const { body } = await providerJson(ctx, 'https://oauth.reddit.com/api/submit', formPost({ api_type: 'json', kind: 'self', sr: subreddit, title, text, resubmit: 'false' }))
    return { ok: true, detail: `Submitted to r/${subreddit}`, receipt: required(body.json?.data?.url || body.json?.data?.name, 'Reddit did not confirm the submission.'), status: 'accepted' }
  }
  if (ctx.app === 'facebook') {
    const page = required(destination, 'Choose a Facebook Page.')
    const { body: account } = await providerJson(ctx, `https://graph.facebook.com/${META_VERSION()}/${segment(page)}?fields=access_token`)
    const pageContext = { ...ctx, token: required(account.access_token, 'Reconnect Facebook and grant publishing access to this Page.') }
    const image = payload.image ? mediaUrl(payload.image) : ''
    const { body } = await providerJson(pageContext, `https://graph.facebook.com/${META_VERSION()}/${segment(page)}/${image ? 'photos' : 'feed'}`, formPost(image ? { url: image, caption: text } : { message: text }))
    return { ok: true, detail: `Published to ${ctx.meta.destinationName || 'your Facebook Page'}`, receipt: required(body.post_id || body.id, 'Facebook did not confirm the post.'), status: 'published' }
  }
  if (ctx.app === 'instagram') {
    const account = required(ctx.meta.accountId, 'Reconnect your Instagram professional account.')
    const video = payload.videoUrl ? mediaUrl(payload.videoUrl) : ''
    const media: Record<string, string> = video ? { media_type: 'REELS', video_url: video, caption: text } : { image_url: mediaUrl(payload.image), caption: text }
    const { body: container } = await providerJson(ctx, `https://graph.instagram.com/${META_VERSION()}/${segment(account)}/media`, formPost(media))
    const id = required(container.id, 'Instagram did not create the media container.')
    // Videos often take longer than one HTTP request. Keep the receipt and
    // finish this same container from the durable publishing queue.
    const status = await instagramProcessingStatus(ctx, id)
    if (['ERROR', 'EXPIRED'].includes(status)) throw new Error('Instagram could not process this media. The draft is saved.')
    if (status !== 'FINISHED') return { ok: true, detail: 'Instagram accepted the media for processing. Nalu will finish publishing when it is ready.', receipt: id, status: 'accepted' }
    return publishInstagramContainer(ctx, id)
  }
  if (ctx.app === 'tiktok') {
    const review = payload.tiktok as Record<string, unknown> | undefined
    if (!review || review.consent !== true) throw new Error('Review this video and confirm its TikTok posting settings before publishing.')
    const creator = { data: await tiktokCreator(ctx) }
    const privacy = validateTikTokReview(creator, review)
    const { body } = await providerJson(ctx, 'https://open.tiktokapis.com/v2/post/publish/video/init/', jsonPost({ post_info: { title: text, privacy_level: privacy, disable_duet: review.allowDuet !== true || !!creator.data.duet_disabled, disable_comment: review.allowComments !== true || !!creator.data.comment_disabled, disable_stitch: review.allowStitch !== true || !!creator.data.stitch_disabled, brand_content_toggle: review.commercial === true && review.brandedContent === true, brand_organic_toggle: review.commercial === true && review.ownBrand === true }, source_info: { source: 'PULL_FROM_URL', video_url: mediaUrl(payload.videoUrl) } }))
    return { ok: true, detail: 'TikTok accepted the video for processing', receipt: required(body.data?.publish_id, 'TikTok did not confirm the upload.'), status: 'accepted' }
  }
  throw new Error('This connection cannot publish this output type.')
}

export async function readProviderInbox(ctx: ProviderContext, limit = 20): Promise<Array<{ id: string; from: string; subject: string; body: string; receivedAt: string }>> {
  const count = Math.max(1, Math.min(50, Math.floor(limit)))
  if (ctx.app === 'gmail') {
    const { body } = await providerJson(ctx, `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=${count}`)
    const result = [], messages = (body.messages || []).slice(0, count)
    for (let start = 0; start < messages.length; start += 5) {
      const batch = await Promise.all(messages.slice(start, start + 5).map(async (message: any) => {
        const { body: mail } = await providerJson(ctx, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${segment(message.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`)
        const header = (name: string) => mail.payload?.headers?.find((h: any) => h.name.toLowerCase() === name)?.value || ''
        return { id: mail.id, from: header('from'), subject: header('subject'), body: mail.snippet || '', receivedAt: new Date(Number(mail.internalDate)).toISOString() }
      }))
      result.push(...batch)
    }
    return result
  }
  if (ctx.app === 'outlook') {
    const { body } = await providerJson(ctx, `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=${count}&$select=id,from,subject,bodyPreview,receivedDateTime&$orderby=receivedDateTime%20desc`)
    return (body.value || []).map((m: any) => ({ id: m.id, from: m.from?.emailAddress?.address || '', subject: m.subject || '', body: m.bodyPreview || '', receivedAt: m.receivedDateTime || '' }))
  }
  if (ctx.app === 'slack') {
    const { body } = await providerJson(ctx, `https://slack.com/api/conversations.history?channel=${segment(required(ctx.meta.destination, 'Choose a Slack channel.'))}&limit=${count}`)
    return (body.messages || []).map((m: any) => ({ id: m.ts, from: m.user || '', subject: ctx.meta.destinationName || 'Slack', body: m.text || '', receivedAt: new Date(Number(m.ts) * 1000).toISOString() }))
  }
  if (ctx.app === 'github') {
    const repo = required(ctx.meta.destination, 'Choose a GitHub repository.')
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Choose a valid GitHub repository.')
    const { body } = await providerJson(ctx, `https://api.github.com/repos/${repo}/issues?state=open&per_page=${count}`, { headers: githubHeaders })
    return (Array.isArray(body) ? body : []).map((m: any) => ({ id: String(m.id), from: m.user?.login || '', subject: m.title || '', body: m.body || '', receivedAt: m.updated_at || '' }))
  }
  if (ctx.app === 'reddit') {
    const destination = required(ctx.meta.destination, 'Choose a Reddit community.')
    if (!/^[A-Za-z0-9_]{2,50}$/.test(destination)) throw new Error('Use a valid subreddit name.')
    const { body } = await providerJson(ctx, `https://oauth.reddit.com/r/${destination}/new?limit=${count}`)
    return (body.data?.children || []).map(({ data: m }: any) => ({ id: m.name, from: m.author || '', subject: m.title || '', body: m.selftext || m.url || '', receivedAt: new Date(m.created_utc * 1000).toISOString() }))
  }
  if (ctx.app === 'instagram') {
    const { body } = await providerJson(ctx, `https://graph.instagram.com/${META_VERSION()}/${segment(required(ctx.meta.accountId, 'Reconnect Instagram.'))}/media?fields=id,caption,permalink,timestamp&limit=${count}`)
    return (body.data || []).map((m: any) => ({ id: m.id, from: ctx.username || '', subject: 'Instagram post', body: m.caption || m.permalink || '', receivedAt: m.timestamp || '' }))
  }
  if (ctx.app === 'facebook') {
    const page = segment(required(ctx.meta.destination, 'Choose a Facebook Page.'))
    const { body: account } = await providerJson(ctx, `https://graph.facebook.com/${META_VERSION()}/${page}?fields=access_token`)
    const { body } = await providerJson({ ...ctx, token: required(account.access_token, 'Reconnect Facebook.') }, `https://graph.facebook.com/${META_VERSION()}/${page}/feed?fields=id,message,created_time&limit=${count}`)
    return (body.data || []).map((m: any) => ({ id: m.id, from: ctx.meta.destinationName || '', subject: 'Facebook post', body: m.message || '', receivedAt: m.created_time || '' }))
  }
  if (ctx.app === 'x') {
    const { body } = await providerJson(ctx, `https://api.x.com/2/users/${segment(required(ctx.meta.accountId, 'Reconnect X.'))}/tweets?max_results=${Math.max(5, count)}&tweet.fields=created_at`)
    return (body.data || []).map((m: any) => ({ id: m.id, from: ctx.username || '', subject: 'X post', body: m.text || '', receivedAt: m.created_at || '' }))
  }
  if (ctx.app === 'tiktok') {
    const { body } = await providerJson(ctx, 'https://open.tiktokapis.com/v2/video/list/?fields=id,title,create_time,share_url', jsonPost({ max_count: Math.min(20, count) }))
    return (body.data?.videos || []).map((m: any) => ({ id: m.id, from: ctx.username || '', subject: m.title || 'TikTok video', body: m.share_url || '', receivedAt: new Date(m.create_time * 1000).toISOString() }))
  }
  throw new Error('This connection supports publishing only. Use its inbound webhook for external updates.')
}
