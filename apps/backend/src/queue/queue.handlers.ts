/**
 * Queue handler contract. Business modules contribute handlers by providing
 * an array under the QUEUE_HANDLERS token; the worker picks the handler by
 * `jobType` at execution time (REQUIREMENTS §70: central queue engine).
 */
export interface QueueHandler {
  type: string;
  handle(payload: unknown): Promise<void>;
}

export const QUEUE_HANDLERS = Symbol('QUEUE_HANDLERS');

/** The built-in handler used by tests / smoke checks. */
export const testEchoHandler: QueueHandler = {
  type: 'test.echo',
  handle: async (payload) => {
    // Intentionally returns nothing — the echo semantics live in the caller.
    return;
  },
};

/**
 * Pure retry-backoff calculation (seconds): exponential 60 * 4^(attempt-1),
 * capped at 6 hours (21600 s). `attempt` is the failed attempt number
 * (1 = first failure → 60 s, 2 → 240 s, 3 → 960 s, …).
 */
export function calcBackoffDelay(attempt: number): number {
  const delay = Math.min(60 * Math.pow(4, Math.max(attempt, 1) - 1), 21600);
  return Math.round(delay);
}
