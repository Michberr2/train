export function parseChatProbe(raw, status) {
  let text = '', kind = null, servingModel = null, finished = false
  const errors = []
  for (const block of raw.replace(/\r\n/g, '\n').split('\n\n')) {
    const event = block.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim()
    const payload = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!payload) continue
    if (payload === '[DONE]') {finished = true; continue}
    let data
    try {data = JSON.parse(payload)} catch {errors.push('invalid event JSON'); continue}
    if (event === 'route') {
      kind = typeof data.kind === 'string' ? data.kind : null
      // A display name is not a serving-model attestation.
      if (typeof data.servingModel === 'string') servingModel = data.servingModel
    }
    if (event === 'error') errors.push('server error')
    if (event === 'done') finished = true
    if (typeof data.text === 'string') text += data.text
  }
  return {text, kind, servingModel, status, finished, errors}
}

export function verifyProbeRouting(domain, on, off) {
  const reasons = []
  const usable = probe => probe?.status === 200 && probe.finished && probe.text.trim() && !probe.errors.length
  if (!usable(on)) reasons.push('on-topic response incomplete or unsuccessful')
  if (on?.kind !== domain.kind) reasons.push('on-topic route differs from expected kind')
  if (!domain.offTopic || !domain.offTopicKind) reasons.push('off-topic prompt and expected kind are required')
  if (!usable(off)) reasons.push('off-topic response incomplete or unsuccessful')
  if (off?.kind !== domain.offTopicKind) reasons.push('off-topic route differs from expected kind')
  return {passed: reasons.length === 0, reasons}
}
