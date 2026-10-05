/**
 * Pure notification-rule condition evaluation (no Prisma, fully unit-testable).
 *
 * Supported shapes:
 *   undefined/null                     → always matches
 *   {"all":[condition | group, ...]}   → every item matches
 *   {"any":[condition | group, ...]}   → at least one item matches
 *   condition: {field, equals?} | {field, in?: unknown[]} |
 *              {field, gt?: number} | {field, lt?: number}
 * Groups nest recursively. Unknown operators never match.
 */

export interface RuleCondition {
  field: string;
  equals?: unknown;
  in?: unknown[];
  gt?: number;
  lt?: number;
}

export interface RuleConditionGroup {
  all?: (RuleCondition | RuleConditionGroup)[];
  any?: (RuleCondition | RuleConditionGroup)[];
}

export type RuleConditions = RuleConditionGroup | undefined | null;

function isGroup(item: RuleCondition | RuleConditionGroup): item is RuleConditionGroup {
  return 'all' in (item as object) || 'any' in (item as object);
}

function resolveField(event: Record<string, unknown>, field: string): unknown {
  return field
    .split('.')
    .reduce<unknown>(
      (acc, part) =>
        acc !== null && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[part]
          : undefined,
      event,
    );
}

function matchCondition(condition: RuleCondition, event: Record<string, unknown>): boolean {
  const value = resolveField(event, condition.field);
  if ('equals' in condition && condition.equals !== undefined) {
    return value === condition.equals;
  }
  if ('in' in condition && Array.isArray(condition.in)) {
    return (condition.in as unknown[]).includes(value);
  }
  if ('gt' in condition && condition.gt !== undefined) {
    return typeof value === 'number' && value > Number(condition.gt);
  }
  if ('lt' in condition && condition.lt !== undefined) {
    return typeof value === 'number' && value < Number(condition.lt);
  }
  return false;
}

export function evaluateConditions(
  conditions: RuleConditions,
  event: Record<string, unknown>,
): boolean {
  if (!conditions) return true;
  if (conditions.all) {
    return conditions.all.every((item) =>
      isGroup(item) ? evaluateConditions(item, event) : matchCondition(item, event),
    );
  }
  if (conditions.any) {
    return conditions.any.some((item) =>
      isGroup(item) ? evaluateConditions(item, event) : matchCondition(item, event),
    );
  }
  return true;
}
