// Nalu voice transcription — uses INKLING (natively multimodal: text/image/AUDIO in
// → text out) via Tinker, so dictation isn't gated by HuggingFace token limits.
// Falls back to Groq/OpenAI/HF Whisper if the audio path ever fails.
// POST { audio: <base64 or data URL>, mime? } → { text }.
import { cors } from './_cors'
import { primaryProvider } from './_llm'

function env(n: string): string { return (process.env[n] || '').trim() }
const HF = env('HUGGINGFACE_API_TOKEN') || env('HF_TOKEN')
const GROQ = env('GROQ_API_KEY')
const OPENAI = env('OPENAI_API_KEY')

function fmtOf(mime: string): string {
  if (/wav/i.test(mime)) return 'wav'
  if (/mp4|m4a|aac/i.test(mime)) return 'm4a'
  if (/mpeg|mp3/i.test(mime)) return 'mp3'
  if (/ogg/i.test(mime)) return 'ogg'
  return 'webm'
}
const PROMPT = 'Transcribe this audio to text exactly, word for word, in whatever language is spoken. Output ONLY the transcription — no preamble, quotes, labels, or commentary. If there is no speech, output nothing.'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }
  let body: Record<string, unknown> = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {} } catch { res.status(400).json({ error: 'invalid JSON' }); return }
  const rawIn = typeof body.audio === 'string' ? body.audio : ''
  if (!rawIn) { res.status(400).json({ error: 'audio required' }); return }
  const b64 = rawIn.includes(',') ? rawIn.split(',')[1] : rawIn
  const mimeMatch = /^data:([^;]+);/.exec(rawIn)
  const mime = (typeof body.mime === 'string' && body.mime) || (mimeMatch ? mimeMatch[1] : 'audio/webm')
  const bytes = Buffer.from(b64, 'base64')
  if (!bytes.length) { res.status(400).json({ error: 'empty audio' }); return }

  let inklingDebug = 'not-tried'
  try {
    // 1) INKLING (Tinker) — the primary, multimodal transcriber. Try both the
    // OpenAI input_audio shape AND an audio_url shape (endpoints differ).
    const p = primaryProvider()
    if (p) {
      for (const part of [
        { type: 'input_audio', input_audio: { data: b64, format: fmtOf(mime) } },
        { type: 'audio_url', audio_url: { url: `data:${mime};base64,${b64}` } },
      ]) {
        try {
          const r = await fetch(`${p.base}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: p.model, max_tokens: 2000, temperature: 0, reasoning_effort: 'none',
              messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, part] }],
            }),
          })
          const bodyText = await r.text()
          if (!r.ok) { inklingDebug = `${r.status}: ${bodyText.slice(0, 160)}`; continue }
          const j = JSON.parse(bodyText) as { choices?: Array<{ message?: { content?: string } }> }
          const text = j?.choices?.[0]?.message?.content
          if (typeof text === 'string' && text.trim()) { res.status(200).json({ text: text.trim(), engine: 'inkling' }); return }
          inklingDebug = 'empty content'
        } catch (e) { inklingDebug = `throw: ${e instanceof Error ? e.message : 'x'}` }
      }
    }
    // 2) Groq / OpenAI Whisper (fastest hosted fallback)
    if (GROQ || OPENAI) {
      const url = GROQ ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions'
      const fd = new FormData()
      fd.append('file', new Blob([bytes], { type: mime }), `audio.${fmtOf(mime)}`)
      fd.append('model', GROQ ? 'whisper-large-v3' : 'whisper-1')
      const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${GROQ || OPENAI}` }, body: fd })
      const j = (await r.json().catch(() => ({}))) as { text?: string }
      if (r.ok && typeof j.text === 'string') { res.status(200).json({ text: j.text.trim(), engine: 'whisper' }); return }
    }
    // 3) HuggingFace Whisper (last resort)
    if (HF) {
      const r = await fetch('https://router.huggingface.co/hf-inference/models/openai/whisper-large-v3', { method: 'POST', headers: { Authorization: `Bearer ${HF}`, 'Content-Type': mime }, body: bytes })
      const j = (await r.json().catch(() => ({}))) as { text?: string }
      if (r.ok && typeof j.text === 'string') { res.status(200).json({ text: j.text.trim(), engine: 'hf' }); return }
    }
    res.status(502).json({ error: 'transcription unavailable', inkling: inklingDebug })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'transcription error' })
  }
}
