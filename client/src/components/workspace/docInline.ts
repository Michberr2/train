export type DocRun = { text: string; bold?: boolean; italic?: boolean; url?: string }
export function documentRuns(text: string): DocRun[] {
  const runs: DocRun[] = []
  // A small, deterministic inline format shared by preview and both exports.
  const tokens = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|(?<!\*)\*([^*\n]+)\*(?!\*)|https?:\/\/[^\s<>]+/g
  let offset = 0
  for (const match of text.matchAll(tokens)) {
    if (match.index > offset) runs.push({ text: text.slice(offset, match.index) })
    if (match[1]) runs.push({ text: match[1], url: match[2] })
    else if (match[3]) runs.push({ text: match[3], bold: true })
    else if (match[4]) runs.push({ text: match[4], italic: true })
    else {
      const url = match[0].replace(/[.,;!?]+$/, '')
      runs.push({ text: url, url })
      if (url.length < match[0].length) runs.push({ text: match[0].slice(url.length) })
    }
    offset = match.index + match[0].length
  }
  if (offset < text.length) runs.push({ text: text.slice(offset) })
  return runs
}
