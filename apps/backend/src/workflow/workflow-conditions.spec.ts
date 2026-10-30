import {
  evaluateCondition,
  isValidConditionTree,
  type ConditionNode,
} from './workflow-conditions';

/**
 * Pure unit tests for the structured condition evaluator — no DB. Covers
 * nested all/any, every operator, numeric coercion, missing-field semantics
 * and tree validation.
 */
describe('workflow-conditions evaluator', () => {
  it('no condition is always true', () => {
    expect(evaluateCondition(undefined, {})).toBe(true);
    expect(evaluateCondition(null, {})).toBe(true);
  });

  it('eq / ne with numbers, numeric strings and nulls', () => {
    const ctx = { status: 'CONFIRMED', total: 250, totalStr: '250', nothing: null };
    expect(evaluateCondition({ field: 'status', op: 'eq', value: 'CONFIRMED' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'total', op: 'eq', value: 250 }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'totalStr', op: 'eq', value: 250 }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'status', op: 'ne', value: 'DRAFT' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'nothing', op: 'eq', value: null }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'total', op: 'eq', value: 251 }, ctx)).toBe(false);
  });

  it('ordering operators are numeric-only — a missing operand never satisfies', () => {
    const ctx = { total: 150, totalStr: '150' };
    expect(evaluateCondition({ field: 'total', op: 'gte', value: 150 }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'total', op: 'gt', value: 149.5 }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'total', op: 'lt', value: 151 }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'totalStr', op: 'lte', value: '150' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'total', op: 'gt', value: 150 }, ctx)).toBe(false);
    // missing / non-numeric operand → false (never accidental pass)
    expect(evaluateCondition({ field: 'ghost', op: 'lt', value: 10 }, ctx)).toBe(false);
    expect(evaluateCondition({ field: 'ghost', op: 'gt', value: 10 }, ctx)).toBe(false);
    expect(evaluateCondition({ field: 'total', op: 'gte', value: 'abc' }, ctx)).toBe(false);
  });

  it('in / notIn / contains over strings and arrays', () => {
    const ctx = { grade: 'A3', tags: ['steel', 'rebar'], note: 'بارگیری سنگین' };
    expect(evaluateCondition({ field: 'grade', op: 'in', value: ['A3', 'A4'] }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'grade', op: 'notIn', value: ['A4'] }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'note', op: 'contains', value: 'سنگین' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'tags', op: 'contains', value: 'rebar' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'grade', op: 'in', value: ['A4'] }, ctx)).toBe(false);
    expect(evaluateCondition({ field: 'note', op: 'contains', value: 'سبک' }, ctx)).toBe(false);
  });

  it('dot paths resolve nested context', () => {
    const ctx = { order: { customer: { credit: 42 } } };
    expect(evaluateCondition({ field: 'order.customer.credit', op: 'gte', value: 40 }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'order.customer.ghost', op: 'eq', value: 1 }, ctx)).toBe(false);
  });

  it('nested all/any combine', () => {
    const cond: ConditionNode = {
      all: [
        { field: 'total', op: 'gte', value: 100 },
        {
          any: [
            { field: 'urgent', op: 'eq', value: true },
            { field: 'customerLevel', op: 'eq', value: 'VIP' },
          ],
        },
      ],
    };
    expect(evaluateCondition(cond, { total: 120, urgent: true })).toBe(true);
    expect(evaluateCondition(cond, { total: 120, customerLevel: 'VIP' })).toBe(true);
    expect(evaluateCondition(cond, { total: 120 })).toBe(false);
    expect(evaluateCondition(cond, { total: 50, urgent: true })).toBe(false);
  });

  it('empty all/any groups are invalid trees', () => {
    expect(isValidConditionTree({ all: [] })).toBe(false);
    expect(isValidConditionTree({ any: [] })).toBe(false);
    expect(isValidConditionTree({ field: 'a', op: 'eq', value: 1 })).toBe(true);
    expect(isValidConditionTree({ field: 'a', op: 'nope', value: 1 })).toBe(false);
    expect(isValidConditionTree({ all: [{ field: 'a', op: 'eq', value: 1 }] })).toBe(true);
    expect(isValidConditionTree('not-a-tree')).toBe(false);
  });
});
