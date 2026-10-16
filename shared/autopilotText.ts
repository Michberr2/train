/** The same plain-text rendering for browser and tab-closed Autopilot files. */
export function cleanPlainText(s: string): string {
  return s
    .replace(/^\s*\|?[\s|:-]+\|[\s|:-]*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*(---+|\*\*\*+|___+)\s*$/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function textFileBody(brief: string, input: string): string {
  return cleanPlainText(brief.includes('{{input}}') ? brief.split('{{input}}').join(input) : [brief, input].filter(Boolean).join('\n\n'))
}

export function textFileName(label: string): string {
  return `${(label || 'output').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '').trim().slice(0, 48) || 'output'}.txt`
}
