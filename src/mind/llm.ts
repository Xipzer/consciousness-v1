export interface ChatResult {
  content: string
  json: unknown
  tokens: number
  logprobs: number[]
  meanLogprob: number
  minLogprob: number
  ms: number
}

export interface ChatOptions {
  url: string
  system: string
  user: string
  schema?: object
  maxTokens?: number
  temperature?: number
  seed?: number
  slot?: number
  signal?: AbortSignal
}

export const chat = async (o: ChatOptions): Promise<ChatResult> => {
  const t0 = performance.now()
  const res = await fetch(`${o.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: o.signal,
    body: JSON.stringify({
      model: 'narrator',
      messages: [
        { role: 'system', content: o.system },
        { role: 'user', content: o.user },
      ],
      max_tokens: o.maxTokens ?? 400,
      temperature: o.temperature ?? 0.3,
      seed: o.seed,
      logprobs: true,
      cache_prompt: true,
      ...(o.slot === undefined ? {} : { id_slot: o.slot }),
      chat_template_kwargs: { enable_thinking: false },
      ...(o.schema ? { response_format: { type: 'json_schema', json_schema: { schema: o.schema } } } : {}),
    }),
  })
  if (!res.ok) throw new Error(`llm ${res.status}: ${await res.text()}`)
  const r = (await res.json()) as {
    choices: { message: { content: string }; logprobs?: { content?: { logprob: number }[] } }[]
    usage: { completion_tokens: number }
  }
  const c = r.choices[0]!
  const logprobs = (c.logprobs?.content ?? []).map((t) => t.logprob)
  if (!logprobs.length) throw new Error('llm returned no per-token logprobs')
  let json: unknown = null
  try {
    json = JSON.parse(c.message.content)
  } catch {}
  return {
    content: c.message.content,
    json,
    tokens: r.usage.completion_tokens,
    logprobs,
    meanLogprob: logprobs.reduce((a, b) => a + b, 0) / logprobs.length,
    minLogprob: Math.min(...logprobs),
    ms: performance.now() - t0,
  }
}
