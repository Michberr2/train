// Nalu TTS — a NATURAL spoken voice for the mobile voice screen. Inkling is a
// text model (it can't emit audio), so the reply TEXT comes from Inkling and THIS
// turns it into human-sounding speech via a neural TTS provider. Preferred is
// Fish Audio (natural British voices); OpenAI and ElevenLabs are fallbacks.
// Returns audio/mpeg the app streams straight into expo-av. When no provider key
// is set it returns 501 and the app falls back to the best on-device voice — so
// voice always works, and it upgrades to a premium voice the moment a key is
// added (FISH_API_KEY preferred; else OPENAI_API_KEY or ELEVENLABS_API_KEY).
//
// The Fish key lives HERE (server-side) — never in the mobile app — so it can't be
// extracted from a shipped build.
//
//   GET  /api/tts?text=Hello&voice=britishWoman   (expo-av streams this URL directly)
//   POST /api/tts { text, voice }
import { cors } from './_cors'
import { readProviderStream } from './_chatStream'
import { TimedSpeech } from './_speechTiming'

function env(n: string): string | undefined { const v = process.env[n]; return v && v.trim() ? v.trim() : undefined }

// Named Fish Audio voices → public voice-model reference IDs (the accent/timbre).
// The app sends a friendly name ('britishWoman' | 'britishMan'); we map it here so
// swapping a voice never needs an app release. Anything else falls back to the woman.
const FISH_VOICES: Record<string, string> = {
  britishwoman: '32e344f53f114cfcbb7ed086f10f2403', // "british female" — warm, conversational
  britishman: '30c0f62e3e6d45d88387d1b8f84e1685', // "Liam" — calm, natural everyday tone
}
function fishReference(voice: string): string {
  const key = voice.toLowerCase().replace(/[^a-z]/g, '')
  return FISH_VOICES[key] || FISH_VOICES.britishwoman
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  let text = ''
  let voice = ''
  let timestamps = false
  if (req.method === 'GET') {
    const url = new URL(req.url, 'https://n4lu.ai')
    text = url.searchParams.get('text') || ''
    voice = url.searchParams.get('voice') || ''
  } else if (req.method === 'POST') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let b: any = {}
    try { b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {} } catch { /* */ }
    text = String(b.text || '')
    voice = String(b.voice || '')
    timestamps = b.timestamps === true
  } else { res.status(405).json({ error: 'GET or POST' }); return }
  text = text.replace(/\s+/g, ' ').trim().slice(0, 1600) // spoken replies are short
  if (!text) { res.status(400).json({ error: 'text required' }); return }

  const fish = env('FISH_API_KEY')
  const openai = env('OPENAI_API_KEY')
  const eleven = env('ELEVENLABS_API_KEY')
  try {
    if (fish) {
      // Fish's latest, most natural engine on the free developer tier (no paid API
      // credit needed). Set FISH_TTS_MODEL to 's2.1-pro' once the account has paid
      // API credit for higher throughput/limits.
      const r = await fetch(timestamps ? 'https://api.fish.audio/v1/tts/stream/with-timestamp' : 'https://api.fish.audio/v1/tts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${fish}`, 'Content-Type': 'application/json', model: env('FISH_TTS_MODEL') || 's2.1-pro-free' },
        body: JSON.stringify({ text, reference_id: fishReference(voice), format: 'mp3', mp3_bitrate: 128, normalize: true, latency: 'normal' }),
      })
      if (!r.ok) { res.status(502).json({ error: `fish tts ${r.status}` }); return }
      if (timestamps) {
        if (!r.body) throw new Error('Voice audio was empty.')
        const speech = new TimedSpeech()
        await readProviderStream(r.body, event => speech.add(event))
        res.setHeader('Cache-Control','no-store')
        res.status(200).json(speech.result()); return
      }
      const buf = Buffer.from(await r.arrayBuffer())
      res.setHeader('Content-Type', 'audio/mpeg')
      res.setHeader('Cache-Control', 'no-store')
      res.status(200).send(buf); return
    }
    if (openai) {
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${openai}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: env('NALU_TTS_MODEL') || 'gpt-4o-mini-tts', voice: voice || env('NALU_TTS_VOICE') || 'nova', input: text, response_format: 'mp3' }),
      })
      if (!r.ok) { res.status(502).json({ error: `openai tts ${r.status}` }); return }
      const buf = Buffer.from(await r.arrayBuffer())
      res.setHeader('Content-Type', 'audio/mpeg')
      res.setHeader('Cache-Control', 'no-store')
      res.status(200).send(buf); return
    }
    if (eleven) {
      const vid = voice || env('NALU_ELEVEN_VOICE') || 'EXAVITQu4vr4xnSDxMaL' // "Sarah" — warm, natural
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
        method: 'POST',
        headers: { 'xi-api-key': eleven, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: env('NALU_ELEVEN_MODEL') || 'eleven_turbo_v2_5' }),
      })
      if (!r.ok) { res.status(502).json({ error: `eleven tts ${r.status}` }); return }
      const buf = Buffer.from(await r.arrayBuffer())
      res.setHeader('Content-Type', 'audio/mpeg')
      res.setHeader('Cache-Control', 'no-store')
      res.status(200).send(buf); return
    }
    // No provider configured — the app uses the best on-device voice instead.
    res.status(501).json({ error: 'no tts provider — set OPENAI_API_KEY or ELEVENLABS_API_KEY for a premium voice' })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message.slice(0, 120) : 'tts error' })
  }
}
