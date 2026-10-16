export type SpeechWord = {text: string; start: number; end: number}

// Audio packets are deltas; alignment snapshots replace earlier metadata for
// the same text chunk. They must not be appended like the audio bytes.
export class TimedSpeech {
  private audio: Buffer[] = []
  private bytes = 0
  private chunks = new Map<number, SpeechWord[]>()
  add(event: any) {
    if (typeof event.audio_base64 === 'string' && event.audio_base64) {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(event.audio_base64)) throw new Error('Invalid voice audio.')
      const bytes = Buffer.from(event.audio_base64,'base64')
      this.bytes += bytes.length
      if (this.bytes > 12 * 1024 * 1024) throw new Error('Voice audio exceeded its limit.')
      this.audio.push(bytes)
    }
    if (!event.alignment) return
    const offset = event.chunk_audio_offset_sec
    if (!Number.isInteger(event.chunk_seq) || event.chunk_seq < 0 || !Number.isFinite(offset) || offset < 0 || !Array.isArray(event.alignment.segments)) throw new Error('Invalid voice timing.')
    const segments = event.alignment.segments.map((word: any) => {
      if (typeof word.text !== 'string' || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end < word.start) throw new Error('Invalid voice timing.')
      return {text:word.text,start:offset+word.start,end:offset+word.end}
    })
    this.chunks.set(event.chunk_seq,segments)
  }
  result() {
    if (this.bytes < 1000) throw new Error('Voice audio was empty.')
    const segments = [...this.chunks].sort(([a],[b])=>a-b).flatMap(([,words])=>words)
    return {audioBase64:Buffer.concat(this.audio).toString('base64'),segments}
  }
}
