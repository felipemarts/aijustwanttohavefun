import { pino, type DestinationStream, type Logger } from 'pino';

/**
 * Structured logs without secrets (PLANEJAMENTO §15.3). Request and response bodies are never logged, so API keys
 * and claim tokens can only leak through headers; those are censored here as a second line of defence.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-admin-token"]',
  'req.headers.cookie',
  'headers.authorization',
  'headers["x-admin-token"]',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, destination);
}
