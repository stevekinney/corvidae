import { DEFAULT_SESSION_BUDGETS, type SessionBudgets } from './session-types.ts';

const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;

type Range = { readonly minimum: number; readonly maximum: number };

/** The permitted range of each budget, from documentation/terminal/security-and-budgets.md. */
export const SESSION_BUDGET_RANGES: Readonly<Record<keyof SessionBudgets, Range>> = {
  operationQueueLimit: { minimum: 1, maximum: 4_096 },
  reservedControlCapacity: { minimum: 1, maximum: 64 },
  inputQueueBytes: { minimum: 1, maximum: MEBIBYTE },
  outputQueueBytes: { minimum: 64 * KIBIBYTE, maximum: 16 * MEBIBYTE },
  inputAcknowledgementDeadlineMilliseconds: { minimum: 250, maximum: 10_000 },
  livenessDeadlineMilliseconds: { minimum: 5_000, maximum: 300_000 },
  cleanupDeadlineMilliseconds: { minimum: 1_000, maximum: 60_000 },
};

/**
 * Merge overrides onto the documented defaults and fail closed on any value outside its range.
 * A missing, non-finite, fractional or out-of-range number throws a `RangeError` naming the budget.
 */
export function resolveSessionBudgets(overrides: Partial<SessionBudgets> = {}): SessionBudgets {
  const resolved: SessionBudgets = { ...DEFAULT_SESSION_BUDGETS, ...overrides };
  for (const name of Object.keys(SESSION_BUDGET_RANGES) as (keyof SessionBudgets)[]) {
    const value = resolved[name];
    const { minimum, maximum } = SESSION_BUDGET_RANGES[name];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(
        `${name} must be an integer from ${minimum} to ${maximum}, got ${value}`,
      );
    }
  }
  return resolved;
}
