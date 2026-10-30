/**
 * Structured workflow condition evaluator (Phase 9B, REQUIREMENTS §27:
 * «شرط‌ها باید ساختاریافته و قابل اعتبارسنجی باشند»). A condition is a
 * JSON tree:
 *
 *   { "all": [ <node>, <node>, ... ] }   — every child must hold
 *   { "any": [ <node>, <node>, ... ] }   — at least one child holds
 *   { "field": "<context path>", "op": "<op>", "value": <literal> }
 *
 * Context paths are simple top-level keys of the instance context object
 * (dot paths like "order.total" resolve stepwise). Pure function — no I/O —
 * so the engine's behavior is unit-testable without a database.
 */

export type ConditionOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'notIn'
  | 'contains';

export interface ConditionLeaf {
  field: string;
  op: ConditionOperator;
  value: unknown;
}

export interface ConditionAll {
  all: ConditionNode[];
}

export interface ConditionAny {
  any: ConditionNode[];
}

export type ConditionNode = ConditionLeaf | ConditionAll | ConditionAny;

export function isValidConditionTree(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  if ('all' in node || 'any' in node) {
    const children = ('all' in node ? (node as ConditionAll).all : (node as ConditionAny).any);
    if (!Array.isArray(children) || children.length === 0) return false;
    return children.every((child) => isValidConditionTree(child));
  }
  const leaf = node as Partial<ConditionLeaf>;
  const OPS: readonly string[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'contains'];
  return (
    typeof leaf.field === 'string' &&
    leaf.field.length > 0 &&
    typeof leaf.op === 'string' &&
    OPS.includes(leaf.op)
  );
}

function resolvePath(context: Record<string, unknown>, path: string): unknown {
  let current: unknown = context;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function evaluateLeaf(leaf: ConditionLeaf, context: Record<string, unknown>): boolean {
  const actual = resolvePath(context, leaf.field);
  const expected = leaf.value;
  switch (leaf.op) {
    case 'eq':
      return looseEquals(actual, expected);
    case 'ne':
      return !looseEquals(actual, expected);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toNumber(actual);
      const b = toNumber(expected);
      // A missing / non-numeric operand can never satisfy an ordering —
      // silent string coercion would make conditions accidentally pass.
      if (a === null || b === null) return false;
      if (leaf.op === 'gt') return a > b;
      if (leaf.op === 'gte') return a >= b;
      if (leaf.op === 'lt') return a < b;
      return a <= b;
    }
    case 'in':
      return Array.isArray(expected) && expected.some((item) => looseEquals(actual, item));
    case 'notIn':
      return !(Array.isArray(expected) && expected.some((item) => looseEquals(actual, item)));
    case 'contains':
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.includes(expected);
      }
      if (Array.isArray(actual)) return actual.some((item) => looseEquals(item, expected));
      return false;
    default:
      return false;
  }
}

function looseEquals(actual: unknown, expected: unknown): boolean {
  if (actual === null || actual === undefined) {
    return expected === null || expected === undefined;
  }
  if (actual === expected) return true;
  const aNum = toNumber(actual);
  const bNum = toNumber(expected);
  if (aNum !== null && bNum !== null) return aNum === bNum;
  if (typeof actual === 'boolean' || typeof expected === 'boolean') {
    return String(actual) === String(expected);
  }
  return false;
}

export function evaluateCondition(
  node: ConditionNode | null | undefined,
  context: Record<string, unknown>,
): boolean {
  if (!node) return true; // no condition = always allowed
  if ('all' in node) {
    const children = (node as ConditionAll).all;
    return children.every((child) => evaluateCondition(child, context));
  }
  if ('any' in node) {
    const children = (node as ConditionAny).any;
    return children.some((child) => evaluateCondition(child, context));
  }
  return evaluateLeaf(node as ConditionLeaf, context);
}
