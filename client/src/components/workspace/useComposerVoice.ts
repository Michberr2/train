import { useEffect, useRef, useState } from 'react'

export const VOICE_RECORDING_MS = 60000
export const VOICE_RECORDING_BYTES = 2 * 1024 * 1024 // below the server's 3 MiB decoded-audio limit
export const VOICE_TRANSCRIPT_MS = 35000 // server deadline is 30 seconds
type State = { phase: 'idle' | 'requesting' | 'listening' | 'transcribing'; message: string; error: boolean }
type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean
  start(): void; stop(): void; abort?(): void
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
}
type Operation = { context: string; token: string; recorder?: MediaRecorder; stream?: MediaStream; recognition?: Recognition; abort?: AbortController; timers: Array<ReturnType<typeof setTimeout>>; watch?: ReturnType<typeof setInterval>; stopped: boolean }
type Options = { contextKey: string; accountToken: string; getInput(): string; setInput(value: string): void }
const readToken = () => { try { return localStorage.getItem('nalu-token') || '' } catch { return '' } }
const permissionMessage = (error: unknown) => {
  const name = error instanceof Error || error instanceof DOMException ? error.name : ''
  return name === 'NotAllowedError' || name === 'SecurityError' ? 'Microphone access was denied. Allow microphone access in your browser settings, then try again.'
    : name === 'NotFoundError' ? 'No microphone was found. Connect a microphone, then try again.'
    : name === 'NotReadableError' ? 'Your microphone is unavailable or busy. Close other recording apps, then try again.'
    : 'Could not start voice input. Check your microphone and try again.'
}
export function transcriptionError(status: number, detail?: unknown): string {
  if (status === 401 || status === 403) return 'Voice transcription is not permitted for this session. Sign in again or check your account access.'
  if (status === 429) return 'The voice transcription limit has been reached. Wait and try again later.'
  if (status === 413) return 'This recording is too large. Try a shorter voice message.'
  if (status === 415) return 'This browser recorded an unsupported audio format. Try another browser or type your message.'
  if (status === 501 || status === 502 || status === 503 || status === 504) return 'Voice transcription is temporarily unavailable. Try again shortly or type your message.'
  return typeof detail === 'string' && detail.trim() ? detail.trim().slice(0, 300) : 'Could not transcribe your voice. Please try again.'
}

/** Own every microphone, callback and fetch for exactly one chat/account. */
export function useComposerVoice(options: Options) {
  const latest = useRef(options); latest.current = options
  const mounted = useRef(false), operation = useRef<Operation | null>(null)
  const [state, setState] = useState<State>({ phase: 'idle', message: '', error: false })
  const publish = (next: State) => { if (mounted.current) setState(next) }
  const dispose = (op: Operation) => {
    if (operation.current === op) operation.current = null
    op.abort?.abort(); op.timers.forEach(clearTimeout); if (op.watch) clearInterval(op.watch)
    if (op.recognition) {
      op.recognition.onresult = null; op.recognition.onend = null; op.recognition.onerror = null
      try { if (op.recognition.abort) op.recognition.abort(); else op.recognition.stop() } catch { /* already stopped */ }
    }
    if (op.recorder) {
      op.recorder.ondataavailable = null; op.recorder.onstop = null; op.recorder.onerror = null
      try { if (op.recorder.state !== 'inactive') op.recorder.stop() } catch { /* already stopped */ }
    }
    op.stream?.getTracks().forEach(track => track.stop())
  }
  const current = (op: Operation) => mounted.current && operation.current === op && latest.current.contextKey === op.context && latest.current.accountToken === op.token && readToken() === op.token
  const end = (op: Operation, message: string, error = false) => { if (!current(op)) { dispose(op); return }; dispose(op); publish({ phase: 'idle', message, error }) }
  const cancel = () => { const op = operation.current; if (op) dispose(op); publish({ phase: 'idle', message: 'Voice input cancelled.', error: false }) }
  const append = (op: Operation, transcript: string) => {
    if (!current(op)) { dispose(op); return }
    const text = transcript.trim()
    if (!text) { end(op, 'No speech was detected. Speak clearly and try again.'); return }
    const before = latest.current.getInput().trimEnd()
    latest.current.setInput((before ? before + ' ' : '') + text)
    end(op, 'Voice text added. Review it before sending.')
  }
  useEffect(() => {
    mounted.current = true
    publish({ phase: 'idle', message: '', error: false })
    const onAccountChange = () => { const op = operation.current; if (op && !current(op)) { dispose(op); publish({ phase: 'idle', message: '', error: false }) } }
    window.addEventListener('storage', onAccountChange)
    return () => { mounted.current = false; window.removeEventListener('storage', onAccountChange); const op = operation.current; if (op) dispose(op) }
    // Callbacks read latest.current, and cleanup invalidates old callbacks before
    // another chat/account is allowed to own the microphone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.contextKey, options.accountToken])

  const start = async () => {
    if (operation.current) return
    const op: Operation = { context: latest.current.contextKey, token: latest.current.accountToken, timers: [], stopped: false }
    operation.current = op
    if (!current(op)) { end(op, 'Your account changed. Reopen this chat before using voice input.', true); publish({ phase: 'idle', message: 'Your account changed. Reopen this chat before using voice input.', error: true }); return }
    // Same-document account writes do not fire the browser storage event.
    op.watch = setInterval(() => { if (operation.current !== op) { dispose(op); return }; if (!current(op)) { dispose(op); publish({ phase: 'idle', message: '', error: false }) } }, 250)
    const SR = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition
    if (SR) {
      try {
        const rec = new SR(); op.recognition = rec
        rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false
        let finalText = ''
        rec.onresult = event => {
          if (!current(op)) { dispose(op); return }
          finalText = Array.from(event.results).filter(result => result.isFinal !== false).map(result => result[0]?.transcript || '').join(' ')
        }
        rec.onend = () => append(op, finalText)
        rec.onerror = event => end(op, event.error === 'no-speech' ? 'No speech was detected. Speak clearly and try again.' : event.error === 'not-allowed' || event.error === 'service-not-allowed' ? 'Microphone access was denied. Allow microphone access in your browser settings, then try again.' : event.error === 'audio-capture' ? 'No usable microphone was found. Check your microphone and try again.' : 'Browser voice recognition is unavailable. Try again or type your message.', event.error !== 'no-speech')
        rec.start(); publish({ phase: 'listening', message: 'Listening… tap again to finish. Maximum 60 seconds.', error: false })
        op.timers.push(setTimeout(() => stop(op), VOICE_RECORDING_MS))
        return
      } catch (error) { end(op, permissionMessage(error), true); return }
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { end(op, 'Voice recording is unavailable in this browser. Try another browser or type your message.', true); return }
    publish({ phase: 'requesting', message: 'Allow microphone access to start recording.', error: false })
    const permissionTimer = setTimeout(() => end(op, 'Microphone permission timed out. Check browser permissions and try again.', true), 20000); op.timers.push(permissionTimer)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      clearTimeout(permissionTimer)
      if (!current(op)) { stream.getTracks().forEach(track => track.stop()); return }
      op.stream = stream
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type))
      const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 64000 }); op.recorder = recorder
      const chunks: Blob[] = []; let bytes = 0
      recorder.ondataavailable = event => {
        if (!current(op) || !event.data?.size) return
        bytes += event.data.size
        if (bytes > VOICE_RECORDING_BYTES) { chunks.length = 0; end(op, 'Recording reached the size limit. Try a shorter voice message.', true); return }
        chunks.push(event.data)
      }
      recorder.onerror = () => end(op, 'Microphone recording failed. Check your microphone and try again.', true)
      recorder.onstop = async () => {
        op.stream?.getTracks().forEach(track => track.stop())
        if (!current(op)) { dispose(op); return }
        op.timers.forEach(clearTimeout); op.timers = []
        const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' })
        if (!blob.size) { end(op, 'No audio was captured. Speak clearly and try again.'); return }
        publish({ phase: 'transcribing', message: 'Transcribing… tap again to cancel.', error: false })
        const abort = new AbortController(); op.abort = abort; let timedOut = false
        op.timers.push(setTimeout(() => { timedOut = true; abort.abort() }, VOICE_TRANSCRIPT_MS))
        try {
          const audio = new Uint8Array(await blob.arrayBuffer()); let binary = ''
          for (let i = 0; i < audio.length; i += 8192) binary += String.fromCharCode(...audio.subarray(i, i + 8192))
          if (!current(op)) { dispose(op); return }
          const response = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(op.token ? { Authorization: `Bearer ${op.token}` } : {}) }, body: JSON.stringify({ audio: `data:${blob.type};base64,${btoa(binary)}`, mime: blob.type }), signal: abort.signal })
          const data = await response.json().catch(() => ({}))
          if (!current(op)) { dispose(op); return }
          if (abort.signal.aborted) throw new Error('Transcription request was aborted')
          if (!response.ok) { end(op, transcriptionError(response.status, data.error), true); return }
          if (typeof data.text !== 'string' || data.text.length > 24000) { end(op, 'Voice transcription returned an invalid result. Please try again.', true); return }
          append(op, data.text)
        } catch { if (current(op)) end(op, timedOut ? 'Voice transcription timed out. Try a shorter message or try again later.' : 'Could not reach voice transcription. Check your connection and try again.', true) }
      }
      recorder.start(250)
      publish({ phase: 'listening', message: 'Recording… tap again to transcribe. Maximum 60 seconds.', error: false })
      op.timers.push(setTimeout(() => stop(op), VOICE_RECORDING_MS))
    } catch (error) { if (current(op)) end(op, permissionMessage(error), true) }
  }
  const stop = (op: Operation) => {
    if (!current(op) || op.stopped) return
    op.stopped = true
    try {
      if (op.recognition) op.recognition.stop()
      else if (op.recorder?.state !== 'inactive') op.recorder?.stop()
      op.stream?.getTracks().forEach(track => track.stop())
      // A browser which never fires stop/end must still release this operation.
      if (current(op)) op.timers.push(setTimeout(() => { if (current(op) && !op.abort) end(op, 'Voice recording did not finish. Please try again.', true) }, 4000))
    } catch { end(op, 'Voice recording could not finish. Please try again.', true) }
  }
  const toggle = () => {
    const op = operation.current
    if (!op) { void start(); return }
    if (op.abort || !op.recorder && !op.recognition) { cancel(); return }
    stop(op)
  }
  const supported = typeof window !== 'undefined' && (!!(window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition || !!(window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition || !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined')
  return { ...state, supported, toggle, cancel }
}
