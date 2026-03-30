import pino from 'pino'

/**
 * Creates a Pino logger instance.
 *
 * @param name - Optional logger name (shows in structured log output)
 * @returns Configured Pino logger
 */
export function createLogger(name?: string): pino.Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    ...(name ? { name } : {}),
    transport:
      process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  })
}

/** Default logger instance for imports that don't need a named logger. */
export const logger = createLogger()
