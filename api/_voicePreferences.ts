export type VoiceLength = 'brief' | 'natural' | 'detailed'
export function voicePreference(value: unknown) {
  const length: VoiceLength = value === 'brief' || value === 'detailed' ? value : 'natural'
  const instructions = {
    brief: 'By default, give one or two short sentences. Skip extra examples unless asked.',
    natural: 'By default, give two or three conversational sentences with the useful detail.',
    detailed: 'By default, explain the answer with supporting detail or an example, usually four to six sentences.',
  }
  return {length, instructions: instructions[length] + ' The latest spoken request for more or less detail takes precedence. Keep the opening sentence useful and concise.', maxChars: length === 'detailed' ? 2200 : 1000, maxTokens: length === 'detailed' ? 1000 : 500}
}
