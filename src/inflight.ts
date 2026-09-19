const active = new Set<Promise<unknown>>()
let accepting = true

/** Keep one event task visible to the bounded process-shutdown drain. */
export function trackInFlight<T>(task: Promise<T>): Promise<T> {
  active.add(task)
  void task.then(
    () => active.delete(task),
    () => active.delete(task),
  )
  return task
}

/**
 * Start an event task unless shutdown has stopped new work from entering.
 *
 * EventEmitter does not observe returned promises, so callers handle and log
 * their own rejection inside the operation.
 */
export function launchInFlight(operation: () => Promise<void>): void {
  if (!accepting) return
  trackInFlight(Promise.resolve().then(operation))
}

/** Stop gateway callbacks and timers from starting more tracked work. */
export function beginInFlightShutdown(): void {
  accepting = false
}

export function inFlightCount(): number {
  return active.size
}

/**
 * Wait until all work that entered before shutdown settles, or until the
 * process has spent its shutdown allowance.
 */
export async function drainInFlight(timeoutMs: number): Promise<number> {
  const deadline = Date.now() + Math.max(0, timeoutMs)

  while (active.size > 0) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return active.size

    const snapshot = [...active]
    const settled = Promise.allSettled(snapshot).then(() => true)
    const timedOut = new Promise<false>((resolve) => {
      const timer = setTimeout(resolve, remaining, false)
      void settled.then(() => clearTimeout(timer))
    })

    if (!(await Promise.race([settled, timedOut]))) return active.size
  }

  return 0
}
