import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  drainInFlight,
  inFlightCount,
  trackInFlight,
} from './inflight.ts'

afterEach(async () => {
  vi.useRealTimers()
  await vi.waitFor(() => {
    expect(inFlightCount()).toBe(0)
  })
})

describe('the process-shutdown work drain', () => {
  it('waits for work already in progress', async () => {
    let release: (() => void) | undefined
    const task = new Promise<void>((resolve) => {
      release = resolve
    })

    trackInFlight(task)
    const drained = drainInFlight(1_000)

    expect(inFlightCount()).toBe(1)
    release?.()

    await expect(drained).resolves.toBe(0)
    await expect(task).resolves.toBeUndefined()
  })

  it('returns the number still running when its allowance expires', async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    const task = new Promise<void>((resolve) => {
      release = resolve
    })

    trackInFlight(task)
    const drained = drainInFlight(100)
    await vi.advanceTimersByTimeAsync(100)

    await expect(drained).resolves.toBe(1)
    release?.()
    await task
  })

  it('removes rejected work without leaking another rejection', async () => {
    const task = Promise.reject(new Error('failed event'))
    trackInFlight(task)

    await expect(task).rejects.toThrow('failed event')
    await vi.waitFor(() => {
      expect(inFlightCount()).toBe(0)
    })
  })
})
