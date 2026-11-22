import type { ScheduleRule } from '@agent-learning/coding-agent'
import { isSettingsObject } from './settings-file.js'

export function parseSchedule(value: unknown): ScheduleRule | undefined {
  if (!isSettingsObject(value) || typeof value.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) return
  const { kind, time, weekdays } = value
  if (kind === 'daily' || kind === 'weekdays') {
    if (Object.keys(value).length === 2) return { kind, time }
  } else if (kind === 'weekly' && Object.keys(value).length === 3 && Array.isArray(weekdays)
    && weekdays.length && weekdays.every(day => Number.isInteger(day) && day >= 1 && day <= 7)) {
    return { kind, time, weekdays: [...new Set<number>(weekdays)].sort((a, b) => a - b) }
  }
}

const day = 24 * 60 * 60 * 1000

function localTime(format: Intl.DateTimeFormat, instant: number): number {
  const fields = Object.fromEntries(format.formatToParts(instant).map(part => [part.type, Number(part.value)]))
  const date = new Date(0)
  date.setUTCFullYear(fields.year!, fields.month! - 1, fields.day!)
  date.setUTCHours(fields.hour!, fields.minute!, fields.second!)
  return date.getTime()
}

export function nextScheduleTime(rule: ScheduleRule, timezone: string, now: number): number {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  })
  const [hour, minute] = rule.time.split(':').map(Number)
  const today = new Date(localTime(format, now)).setUTCHours(hour!, minute!, 0, 0)
  for (let target = today; ; target += day) {
    const weekday = new Date(target).getUTCDay() || 7
    if (rule.kind === 'weekdays' && weekday > 5) continue
    if (rule.kind === 'weekly' && !rule.weekdays.includes(weekday)) continue
    // Try the offsets on both sides of an offset change, keeping only exact local-time matches.
    const offsets = [target - day, target, target + day].map(instant => localTime(format, instant) - instant)
    const first = Math.min(...offsets.map(offset => target - offset).filter(instant => localTime(format, instant) === target))
    if (first !== Infinity && first > now) return first
  }
}
