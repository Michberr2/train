// Portable operations: appends and checkbox edits never replace a whole document.
export type Segment = {id?: string; text: string; at: string}
export type ActionItem = {text: string; owner: string | null; due: string | null; done: boolean; taskId?: string}
export type MeetingNote = {id: string; title?: string; createdAt: string; updatedAt?: string; segments: Segment[]; summary: string; actions: ActionItem[]; analyzedCount: number}
export type RecipientGroup = {id: string; name: string; emails: string[]}
export type NoteChange =
  | {kind: 'create'; note: MeetingNote}
  | {kind: 'title'; title: string}
  | {kind: 'append'; segments: Segment[]}
  | {kind: 'analysis'; summary: string; actions: ActionItem[]; analyzedCount: number}
  | {kind: 'check'; key: string; done: boolean}
export type NotebookMutation = {id: string; noteId: string; changes: NoteChange[]}
export const actionKey = (action: ActionItem) => JSON.stringify([action.text, action.owner || null, action.due || null])
export function normalizeNote(note: MeetingNote): MeetingNote {
  return {...note, title: note.title || '', segments: note.segments.map((segment,index) => ({...segment,id:segment.id || `${note.id}-s${index}`}))}
}
export function changeNote(current: MeetingNote | undefined, noteId: string, changes: NoteChange[]): MeetingNote {
  let note = current ? normalizeNote(current) : undefined
  for (const change of changes) {
    if (change.kind === 'create') { if (!note) note = normalizeNote(change.note); continue }
    if (!note) throw new Error('This note could not be found. Sync your notebook and try again.')
    if (change.kind === 'title') note = {...note,title:change.title}
    if (change.kind === 'append') {
      const ids = new Set(note.segments.map(segment=>segment.id))
      note = {...note,segments:[...note.segments,...change.segments.filter(segment=>!ids.has(segment.id))]}
    }
    if (change.kind === 'analysis' && change.analyzedCount >= note.analyzedCount) {
      const previous = new Map(note.actions.map(action=>[actionKey(action),action]))
      const actions = change.actions.map(action => ({...action,done:previous.get(actionKey(action))?.done ?? action.done,...(previous.get(actionKey(action))?.taskId ? {taskId:previous.get(actionKey(action))!.taskId} : {})}))
      for (const action of note.actions) if (action.taskId && !actions.some(next=>actionKey(next)===actionKey(action))) actions.push(action)
      note = {...note,summary:change.summary,actions,analyzedCount:change.analyzedCount}
    }
    if (change.kind === 'check') note = {...note,actions:note.actions.map(action=>actionKey(action)===change.key ? {...action,done:change.done} : action)}
  }
  if (!note || note.id !== noteId) throw new Error('Invalid note.')
  return note
}
export function noteChanges(before: MeetingNote | undefined, after: MeetingNote): NoteChange[] {
  const next = normalizeNote(after)
  if (!before) return [{kind:'create',note:next}]
  const old = normalizeNote(before), changes: NoteChange[] = []
  if (old.title !== next.title) changes.push({kind:'title',title:next.title || ''})
  const ids = new Set(old.segments.map(segment=>segment.id)), appended = next.segments.filter(segment=>!ids.has(segment.id))
  if (appended.length) changes.push({kind:'append',segments:appended})
  if (old.summary !== next.summary || old.analyzedCount !== next.analyzedCount || JSON.stringify(old.actions.map(actionKey)) !== JSON.stringify(next.actions.map(actionKey))) changes.push({kind:'analysis',summary:next.summary,actions:next.actions,analyzedCount:next.analyzedCount})
  const previous = new Map(old.actions.map(action=>[actionKey(action),action.done]))
  for (const action of next.actions) if (previous.has(actionKey(action)) && previous.get(actionKey(action)) !== action.done) changes.push({kind:'check',key:actionKey(action),done:action.done})
  return changes
}
export function searchNotes(notes: MeetingNote[], query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return notes.filter(note => {
    const text = [note.title,note.summary,...note.segments.map(segment=>segment.text),...note.actions.map(action=>[action.text,action.owner,action.due].join(' '))].join(' ').toLocaleLowerCase()
    return terms.every(term=>text.includes(term))
  }).sort((a,b)=>(Date.parse(b.updatedAt || b.createdAt)||0)-(Date.parse(a.updatedAt || a.createdAt)||0))
}
