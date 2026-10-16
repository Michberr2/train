/** Compare calendar slots in the flow's timezone so browser and cloud agree,
 * including daylight-saving changes and a late scheduler wake-up. */
export function isScheduleDue(schedule: string, time: string, lastRun: number, now: Date, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): boolean {
  if (schedule === 'hourly') return now.getTime() - lastRun >= 3_600_000
  if (schedule === 'continuous') return now.getTime() - lastRun >= 1_800_000
  if (!['daily', 'weekly', 'members'].includes(schedule)) return false
  if (!/^\d{1,2}:\d{2}$/.test(time)) return false
  const [hours, minutes] = time.split(':').map(Number)
  if (hours > 23 || minutes > 59) return false
  try {
    const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    const wallTime = (date: Date) => {
      const p = Object.fromEntries(format.formatToParts(date).map(p => [p.type, p.value]))
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
    }
    const wallNow = wallTime(now), scheduled = new Date(wallNow)
    scheduled.setUTCHours(hours, minutes, 0, 0)
    if (schedule === 'weekly') scheduled.setUTCDate(scheduled.getUTCDate() - (scheduled.getUTCDay() + 6) % 7)
    return wallNow >= scheduled.getTime() && (!lastRun || wallTime(new Date(lastRun)) < scheduled.getTime())
  } catch { return false }
}
