export type IcsEvent = { title?: string; start?: string; end?: string; location?: string; description?: string; attendees?: string[] }

type CalendarTime = { value: string; kind: 'date' | 'floating' | 'utc'; order: number }
const encoder = new TextEncoder()

/** RFC5545 date/time values have seconds; numeric offsets become UTC, while
 * an explicitly unzoned wall time remains floating rather than guessing a zone. */
function calendarTime(raw: unknown): CalendarTime {
  if (typeof raw !== 'string') throw new Error('Calendar event needs a valid start date and time.')
  const match = raw.trim().match(/^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2})(?::?(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i)
  if (!match) throw new Error('Calendar dates must use YYYY-MM-DD or an ISO date and time.')
  const [, yy, mm, dd, hh, mi, ss, zone] = match
  const year = Number(yy), month = Number(mm), day = Number(dd)
  const hour = Number(hh || 0), minute = Number(mi || 0), second = Number(ss || 0)
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
    throw new Error('Calendar event contains an invalid date or time.')
  }
  const basic = `${yy}${mm}${dd}`
  if (hh === undefined) return { value: basic, kind: 'date', order: date.getTime() }
  if (!zone) return { value: `${basic}T${hh}${mi}${ss || '00'}`, kind: 'floating', order: date.getTime() }
  if (zone.toUpperCase() !== 'Z') {
    const offset = zone.slice(1).replace(':', ''), hours = Number(offset.slice(0, 2)), minutes = Number(offset.slice(2))
    if (hours > 23 || minutes > 59) throw new Error('Calendar event contains an invalid timezone offset.')
    date.setTime(date.getTime() - (zone[0] === '+' ? 1 : -1) * (hours * 60 + minutes) * 60000)
  }
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) throw new Error('Calendar date is outside the supported range.')
  return { value: date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'), kind: 'utc', order: date.getTime() }
}

function text(value: unknown): string {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/[,;]/g, '\\$&')
}

/** Fold by UTF-8 octets without splitting a multibyte character. */
function fold(line: string): string {
  let current = '', bytes = 0
  const lines: string[] = []
  for (const char of line) {
    const size = encoder.encode(char).length
    if (bytes + size > 75) { lines.push(current); current = ' '; bytes = 1 }
    current += char; bytes += size
  }
  lines.push(current)
  return lines.join('\r\n')
}

/** A downloadable calendar file only: building it never books or invites. */
export function buildIcsBlob(events: IcsEvent[]): Blob {
  if (!Array.isArray(events) || !events.length) throw new Error('No calendar events were provided.')
  const stamp = calendarTime(new Date().toISOString()).value
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Nalu//Employees//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH']
  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== 'object') throw new Error(`Calendar event ${index + 1} is invalid.`)
    for (const field of ['title', 'location', 'description'] as const) if (event[field] != null && typeof event[field] !== 'string') throw new Error(`Calendar event ${field} must be text.`)
    const start = calendarTime(event.start)
    const end = event.end ? calendarTime(event.end) : null
    if (end && (end.kind !== start.kind || end.order <= start.order)) throw new Error('Calendar end must follow its start and use the same timezone format.')
    const attendees = event.attendees ?? []
    if (!Array.isArray(attendees) || attendees.some(address => typeof address !== 'string' || !/^[^\s<>,;:"\\]+@[^\s<>,;:"\\]+$/.test(address))) {
      throw new Error('Calendar attendees must be email addresses.')
    }
    lines.push('BEGIN:VEVENT', `UID:nalu-${crypto.randomUUID()}@n4lu.ai`, `DTSTAMP:${stamp}`,
      `DTSTART${start.kind === 'date' ? ';VALUE=DATE' : ''}:${start.value}`,
      ...(end ? [`DTEND${end.kind === 'date' ? ';VALUE=DATE' : ''}:${end.value}`] : []),
      `SUMMARY:${text(event.title || 'Meeting')}`,
      ...(event.location ? [`LOCATION:${text(event.location)}`] : []),
      ...(event.description ? [`DESCRIPTION:${text(event.description)}`] : []),
      ...attendees.map(address => `ATTENDEE;RSVP=TRUE:mailto:${encodeURIComponent(address).replace(/%40/g, '@')}`),
      'END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return new Blob([lines.map(fold).join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' })
}
