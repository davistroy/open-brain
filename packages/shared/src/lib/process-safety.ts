/**
 * Process-safety helpers: BullMQ `error` listeners and an unhandled-rejection
 * handler. Emitters are typed structurally so @open-brain/shared needs no
 * `bullmq` dependency.
 */

export interface ErrorEmitter {
  name?: string
  on(event: 'error', listener: (err: Error) => void): unknown
}

export interface ErrorLog {
  error(obj: object, msg?: string): unknown
}

export interface FatalLog {
  fatal(obj: object, msg?: string): unknown
}

/** Emitters that already carry our listener — attaching twice is a no-op. */
const attached = new WeakSet<object>()

/**
 * Attach an `error` listener to each emitter that logs through `log` (pino)
 * instead of BullMQ's default console.error. Idempotent per emitter.
 */
export function attachErrorListeners(emitters: readonly ErrorEmitter[], log: ErrorLog): void {
  for (const emitter of emitters) {
    if (attached.has(emitter)) continue
    attached.add(emitter)
    emitter.on('error', (err: Error) => {
      log.error({ err, queue: emitter.name }, 'bullmq error')
    })
  }
}

/**
 * Log an unhandled rejection at `fatal` and exit(1). Never swallows: the
 * container restart policy recovers the process.
 */
export function installUnhandledRejectionHandler(
  log: FatalLog,
  exit: (code: number) => never = process.exit,
): void {
  process.on('unhandledRejection', (reason: unknown) => {
    log.fatal({ err: reason }, 'unhandled promise rejection — exiting')
    exit(1)
  })
}
