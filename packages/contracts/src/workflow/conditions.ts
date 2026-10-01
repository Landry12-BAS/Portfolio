// How a condition step decides which branch a run takes. The comparison is data (a field,
// an operator and an operand), never an expression, so there is nothing to execute.
import type { ComparisonOp } from './catalogue.ts'
import type { Scalar } from './references.ts'

/**
 * Compares the value a condition reads (`actual`) with the operand it was written with
 * (`expected`). A comparison that makes no sense for the two values, such as `gt` on
 * text, is false; `validateWorkflow` refuses such conditions before they are stored, so
 * this only matters for a payload that disagrees with its own event's schema.
 * Text comparisons ignore case.
 */
export function evaluateCondition(op: ComparisonOp, actual: Scalar, expected: Scalar): boolean {
  switch (op) {
    case 'eq':
      return typeof actual === 'string' && typeof expected === 'string' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected
    case 'neq':
      return !evaluateCondition('eq', actual, expected)
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' && actual.toLowerCase().includes(expected.toLowerCase())
  }
}
