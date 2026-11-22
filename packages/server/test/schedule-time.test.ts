import { describe, expect, it } from 'vitest'
import { nextScheduleTime, parseSchedule } from '../src/schedule-time.js'

const at = (value: string) => Date.parse(value)

describe('scheduled local times', () => {
  it('advances daily, weekdays and selected weekdays across a weekend', () => {
    const now = at('2026-11-20T16:01:00Z')
    const zone = 'Asia/Shanghai'
    expect(nextScheduleTime({ kind: 'daily', time: '09:00' }, zone, now)).toBe(at('2026-11-21T01:00:00Z'))
    expect(nextScheduleTime({ kind: 'weekdays', time: '09:00' }, zone, now)).toBe(at('2026-11-23T01:00:00Z'))
    const weekly = { kind: 'weekly', time: '09:00', weekdays: [1, 3] } as const
    expect(nextScheduleTime({ ...weekly, weekdays: [1, 3] }, zone, now)).toBe(at('2026-11-23T01:00:00Z'))
    expect(nextScheduleTime({ ...weekly, weekdays: [1, 3] }, zone, at('2026-11-23T01:00:00Z'))).toBe(at('2026-11-25T01:00:00Z'))
    expect(nextScheduleTime({ ...weekly, weekdays: [3] }, zone, now)).toBe(at('2026-11-25T01:00:00Z'))
  })

  it('keeps the local hour when the offset changes', () => {
    const daily = { kind: 'daily', time: '09:00' } as const
    const zone = 'America/New_York'
    expect(nextScheduleTime(daily, zone, at('2026-03-07T13:30:00Z'))).toBe(at('2026-03-07T14:00:00Z'))
    expect(nextScheduleTime(daily, zone, at('2026-03-07T14:00:00Z'))).toBe(at('2026-03-08T13:00:00Z'))
  })

  it('skips a missing local time and uses the first instance of a repeated one', () => {
    const zone = 'America/New_York'
    expect(nextScheduleTime({ kind: 'daily', time: '02:30' }, zone, at('2026-03-08T00:00:00Z'))).toBe(at('2026-03-09T06:30:00Z'))
    const daily = { kind: 'daily', time: '01:30' } as const
    expect(nextScheduleTime(daily, zone, at('2026-11-01T04:00:00Z'))).toBe(at('2026-11-01T05:30:00Z'))
    expect(nextScheduleTime(daily, zone, at('2026-11-01T05:30:00Z'))).toBe(at('2026-11-02T06:30:00Z'))
  })

  it('rejects unsupported rules, invalid times, empty weekdays and supplied time zones', () => {
    for (const value of [
      { kind: 'once', time: '09:00' },
      { kind: 'daily', time: '24:00' },
      { kind: 'weekly', time: '09:00', weekdays: [] },
      { kind: 'weekly', time: '09:00', weekdays: [0] },
      { kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai' },
    ]) expect(parseSchedule(value)).toBeUndefined()
    expect(parseSchedule({ kind: 'weekly', time: '09:00', weekdays: [3, 1, 3] })).toEqual({
      kind: 'weekly', time: '09:00', weekdays: [1, 3],
    })
  })
})
