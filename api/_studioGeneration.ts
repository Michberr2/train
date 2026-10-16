import { chatCompleteContinued, providerChain } from './_llm'

type Message = { role: string; content: unknown }

/** One request deadline across provider failover, JSON retries and continuation. */
export async function generateStudioJson<T>(options: {
  model: string
  deadlineMs: number
  messages: (attempt: number) => Message[]
  parse: (content: string) => T | null
  maxTokens: number
  temperature: number
  maxCallMs?: number
}): Promise<T | null> {
  const providers = providerChain(options.model)
  if (!providers.length) throw new Error('Nalu engine is not configured.')
  for (let attempt = 0; attempt < 3; attempt++) {
    // Continued completion can make exactly TWO calls. A singleton provider and
    // maxAttempts=1 prevent hidden per-provider/shrink/rate-limit retries from
    // multiplying that bound. Leave 10s for validation, response and quota cleanup.
    const timeoutMs = Math.min(options.maxCallMs ?? 90000, Math.floor((options.deadlineMs - Date.now() - 10000) / 2))
    if (timeoutMs < 1000) break
    try {
      const result = await chatCompleteContinued(options.messages(attempt), {
        model: options.model, maxTokens: options.maxTokens,
        temperature: options.temperature, json: true,
        providers: [providers[attempt % providers.length]],
        maxAttempts: 1, retryPrimary: false, timeoutMs,
      })
      const parsed = options.parse(result.content)
      if (parsed !== null) return parsed
    } catch {
      // A failed or malformed reply advances to the next provider inside the
      // SAME request budget. The endpoint returns a retryable error if all fail.
    }
  }
  return null
}
