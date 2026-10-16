// Older profile completions sometimes included drafting notes or an entire
// answer around the requested profile. Only expose the profile portion.
export function profileText(value: unknown): string {
  for(let i=0;i<6 && typeof value==='string';i++){
    try {value=JSON.parse(value)} catch {break}
  }
  if(value && typeof value==='object' && !Array.isArray(value)){
    const record=value as Record<string,unknown>
    value=record.profile||record.updated_profile||record.memory||Object.values(record).find(v=>typeof v==='string')
  }
  if(typeof value!=='string')return ''
  let text=value.trim().replace(/^```(?:json|text)?\s*/i,'').replace(/\s*```$/,'').replace(/<think>[\s\S]*?<\/think>/gi,'').trim()
  if(/<think>/i.test(text))return ''
  const marker=/UPDATED PROFILE:\s*/i.exec(text)
  if(marker)text=text.slice(marker.index+marker[0].length).split(/\n\s*\n/)[0].trim()
  const bullets=text.split('\n').filter(line=>/^\s*[-*•]\s+/.test(line)).slice(0,25)
  if(bullets.length){
    const kept: string[]=[];let size=0
    for(const line of bullets){if(size+line.length>2000)break;kept.push(line.trim());size+=line.length+1}
    return kept.join('\n')
  }
  if(/^(?:the user message|i should|i need to|let me|analysis:)/i.test(text))return ''
  return text.slice(0,2000)
}
