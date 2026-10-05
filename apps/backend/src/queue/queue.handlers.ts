/**
 * Queue handler contract + pure queue calculations.
 *
 * Business modules contribute handlers by registering them on the
 * QueueHandlerRegistry (see queue.module.ts); the worker picks the handler by
 * `jobType` at execution time (REQUIREMENTS §70: central queue engine).
 */
export interface QueueHandler {
  type: string;
  handle(payload: unknown): Promise<void>;
}

export type QueueJobPriority = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

/**
 * Map a QueueJob priority to a BullMQ numeric priority.
 * BullMQ: lower number = processed sooner → CRITICAL 1 … LOW 4.
 */
export function priorityToBull(priority: QueueJobPriority): number {
  const map: Record<QueueJobPriority, number> = {
    CRITICAL: 1,
    HIGH: 2,
    NORMAL: 3,
    LOW: 4,
  };
  return map[priority] ?? 3;
}

/**
 * Pure retry-backoff calculation (seconds): exponential 60 * 4^(attempt-1),
 * capped at 6 hours (21600 s). `attempt` is the failed attempt number
 * (1 = first failure → 60 s, 2 → 240 s, 3 → 960 s, …).
 */
export function calcBackoffDelay(attempt: number): number {
  const delay = Math.min(60 * Math.pow(4, Math.max(attempt, 1) - 1), 21600);
  return Math.round(delay);
}

/**
 * BullMQ custom backoff strategy (milliseconds) — same curve as
 * calcBackoffDelay, expressed in ms and fed by BullMQ's attemptsMade counter.
 */
export function bullmqBackoffStrategy(attemptsMade: number): number {
  return calcBackoffDelay(Math.max(attemptsMade, 1)) * 1000;
}

/**
 * Registry of queue handlers. Modules register on module init; keeping the
 * registry as an injectable singleton avoids cross-module multi-provider
 * ordering issues.
 */
export class QueueHandlerRegistry {
  private readonly handlers = new Map<string, QueueHandler>();

  register(handler: QueueHandler): void {
    this.handlers.set(handler.type, handler);
  }

  handlerFor(jobType: string): QueueHandler | undefined {
    return this.handlers.get(jobType);
  }

  types(): string[] {
    return [...this.handlers.keys()];
  }
}

/** The built-in handler used by tests / smoke checks. */
export const testEchoHandler: QueueHandler = {
  type: 'test.echo',
  handle: async () => {
    // Intentionally returns nothing — the echo semantics live in the caller.
    return;
  },
};
