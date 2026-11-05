import { providerChain } from './_llm'
import { recoverCompletion } from './_chatRecovery'

/** Inference can fail over safely: no browser action has executed yet. */
export async function browserDecision(system: string, user: string, screenshot: string): Promise<string | null> {
  const providers = providerChain()
  const started = Date.now(), signal = new AbortController().signal
  const content = (data: any) => data?.choices?.[0]?.message?.content
  const usable = (data: any) => {
    const raw = content(data)
    if (typeof raw !== 'string') return false
    try {
      const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
      const parsed = JSON.parse(text), action = parsed.action || parsed
      return ['click', 'type', 'click_at', 'scroll', 'navigate', 'newtab', 'switchtab', 'closetab', 'ask', 'finish', 'press', 'type_text', 'drag'].includes(action.type)
    } catch { return false }
  }
  const run = (vision: boolean) => recoverCompletion({
    providers: vision ? providers.filter(p => p.supportsImages !== false) : providers,
    signal, deadlineMs: started + (vision ? 25000 : 50000),
    payload: p => ({ model: p.model, stream: false, max_tokens: 1200, temperature: 0,
      messages: [{ role: 'system', content: system }, { role: 'user', content: vision ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: screenshot } }] : user }] }),
    accept: usable,
  })
  const result = (screenshot ? await run(true) : null) || await run(false)
  return result ? content(result) : null
}
