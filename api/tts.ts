// Shared mobile/desktop speech synthesis. Friendly voice aliases are mapped
// separately for each provider; failures fall through without changing format.
import { cors } from './_cors'
import { reserveDailyQuota, studioLimitMessage } from './_limits'
import { readProviderStream } from './_chatStream'
import { TimedSpeech } from './_speechTiming'
import { withRequestCancellation } from './_requestCancellation'
import { boundedVoiceStream, fetchVoice, MAX_VOICE_AUDIO_BYTES, readVoiceBytes, validateMp3, withVoiceDeadline } from './_voiceProvider'

function env(name: string): string { return (process.env[name] || '').trim() }
const FISH_VOICES = {britishwoman: '32e344f53f114cfcbb7ed086f10f2403', britishman: '30c0f62e3e6d45d88387d1b8f84e1685'}
const OPENAI_VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'])
export function providerVoice(provider: 'fish' | 'openai' | 'eleven', voice: string): string {
  const alias = voice.toLowerCase().replace(/[^a-z]/g, '')
  const male = alias === 'britishman'
  if (provider === 'fish') return male ? FISH_VOICES.britishman : FISH_VOICES.britishwoman
  if (provider === 'openai') {
    const configured = env('NALU_TTS_VOICE')
    return OPENAI_VOICES.has(voice) ? voice : OPENAI_VOICES.has(configured) ? configured : male ? 'onyx' : 'nova'
  }
  const configured = env(male ? 'NALU_ELEVEN_VOICE_BRITISH_MAN' : 'NALU_ELEVEN_VOICE_BRITISH_WOMAN') || env('NALU_ELEVEN_VOICE')
  if (configured && /^[A-Za-z0-9]{15,64}$/.test(configured)) return configured
  if (/^[A-Za-z0-9]{15,64}$/.test(voice) && !['britishwoman', 'britishman'].includes(alias)) return voice
  return male ? 'JBFqnCBsd6RMkjVDRZzb' : 'EXAVITQu4vr4xnSDxMaL'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  let text: unknown = '', voice: unknown = '', timestamps = false
  if (req.method === 'GET') {
    const url = new URL(req.url, 'https://n4lu.ai')
    text = url.searchParams.get('text') || ''; voice = url.searchParams.get('voice') || ''
    timestamps = url.searchParams.get('timestamps') === 'true'
  } else if (req.method === 'POST') {
    let body
    try {body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}} catch {res.status(400).json({error: 'Invalid JSON.'}); return}
    if (!body || typeof body !== 'object' || Array.isArray(body)) {res.status(400).json({error: 'Invalid speech request.'}); return}
    text = body.text; voice = body.voice || ''; timestamps = body.timestamps === true
  } else {res.setHeader('Allow', 'GET, POST'); res.status(405).json({error: 'GET or POST required.'}); return}
  if (typeof text !== 'string' || typeof voice !== 'string' || voice.length > 100) {res.status(400).json({error: 'Text and voice must be strings.'}); return}
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) {res.status(400).json({error: 'Text required.'}); return}
  if (clean.length > 1600) {res.status(413).json({error: 'Speech text is limited to 1,600 characters.'}); return}
  const selectedVoice = voice
  const providers = [env('FISH_API_KEY') && 'fish', env('OPENAI_API_KEY') && 'openai', env('ELEVENLABS_API_KEY') && 'eleven'].filter(Boolean) as Array<'fish' | 'openai' | 'eleven'>
  if (!providers.length) {res.status(501).json({error: 'Server speech is unavailable. Device speech can still be used.'}); return}
  await withRequestCancellation(req, res, async signal => {
    const deadline = Date.now() + 9000
    const quota = await reserveDailyQuota(req, 'voice-tts', {anonPerDay:120, userPerDay:1200})
    if (!quota.ok) {res.status(quota.status || 429).json({error:studioLimitMessage('voice',quota)});return}
    let delivered = false
    try {
    signal.throwIfAborted()
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i]
      signal.throwIfAborted()
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      try {
        // Reserve a share of the client's ten-second budget for every configured
        // fallback. Both headers and streamed response bytes share this deadline.
        const speech = await withVoiceDeadline(signal, remaining / (providers.length - i), async attempt => {
          let response: Response
          if (provider === 'fish') {
            response = await fetchVoice(timestamps ? 'https://api.fish.audio/v1/tts/stream/with-timestamp' : 'https://api.fish.audio/v1/tts', {
              method: 'POST', headers: {Authorization: `Bearer ${env('FISH_API_KEY')}`, 'Content-Type': 'application/json', model: env('FISH_TTS_MODEL') || 's2.1-pro-free'},
              body: JSON.stringify({text: clean, reference_id: providerVoice(provider, selectedVoice), format: 'mp3', mp3_bitrate: 128, normalize: true, latency: 'normal'}),
            }, attempt)
            if (timestamps) {
              const timed = new TimedSpeech()
              await readProviderStream(boundedVoiceStream(response, 20 * 1024 * 1024, attempt), event => {
                if (event.alignment?.segments?.length > 2000) throw new Error('Too many timing segments.')
                timed.add(event)
              }, attempt)
              const result = timed.result(), bytes = Buffer.from(result.audioBase64, 'base64')
              validateMp3(bytes)
              if (result.segments.length >= 2000 || result.segments.some((word, index) => word.text.length > 500 || word.end > 3600 || index > 0 && word.start < result.segments[index - 1].start)) throw new Error('Invalid voice alignment.')
              return {bytes, segments: result.segments}
            }
          } else if (provider === 'openai') {
            const model = env('NALU_TTS_MODEL') || 'gpt-4o-mini-tts'
            response = await fetchVoice('https://api.openai.com/v1/audio/speech', {
              method: 'POST', headers: {Authorization: `Bearer ${env('OPENAI_API_KEY')}`, 'Content-Type': 'application/json'},
              body: JSON.stringify({model, voice: providerVoice(provider, selectedVoice), input: clean, response_format: 'mp3', ...(/^gpt-4o-mini-tts/.test(model) ? {instructions: 'Speak naturally in a calm British English accent.'} : {})}),
            }, attempt)
          } else {
            response = await fetchVoice(`https://api.elevenlabs.io/v1/text-to-speech/${providerVoice(provider, selectedVoice)}`, {
              method: 'POST', headers: {'xi-api-key': env('ELEVENLABS_API_KEY'), 'Content-Type': 'application/json', Accept: 'audio/mpeg'},
              body: JSON.stringify({text: clean, model_id: env('NALU_ELEVEN_MODEL') || 'eleven_turbo_v2_5'}),
            }, attempt)
          }
          const bytes = await readVoiceBytes(response, MAX_VOICE_AUDIO_BYTES, attempt)
          validateMp3(bytes)
          // No invented word timings when the provider returned raw audio.
          return {bytes, segments: []}
        })
        signal.throwIfAborted()
        res.setHeader('Cache-Control', 'no-store')
        if (timestamps) {res.status(200).json({audioBase64: speech.bytes.toString('base64'), segments: speech.segments}); delivered = true; return}
        res.setHeader('Content-Type', 'audio/mpeg'); res.status(200).send(speech.bytes); delivered = true; return
      } catch {
        signal.throwIfAborted() // A caller cancellation never starts a fallback.
      }
    }
    res.status(502).json({error: 'Voice synthesis is temporarily unavailable. Please try again.'})
    } finally { if (!delivered || signal.aborted) await quota.release() }
  })
}
