/**
 * COR-851 — one validator execution, shared by the in-memory controller
 * (`startGoal`) and Bureau's durable `runValidator` port.
 *
 * A validator that throws, returns something that is not a verdict, runs past
 * its timeout, or is canceled never rejects here: each is a `ValidatorOutcome`
 * the decision core already knows how to read. The outcome is normalized but not
 * projected; a durable caller projects it to JSON itself.
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';

import { toValidatorError } from './errors';
import { normalizeValidatorOutcome, type ValidatorOutcome } from './goal-decision';
import type { Validator, ValidatorInput } from './goal-run';

export interface ValidatorExecution {
  readonly outcome: ValidatorOutcome;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface ValidatorExecutionOptions {
  /** A validator running longer than this ends as an `error` of kind `'timeout'`. */
  readonly timeoutMs?: number | undefined;
  readonly runtime: Pick<RuntimeServices, 'clock' | 'timers'>;
}

/**
 * Runs `validator` once. The returned promise always resolves: `signal` firing
 * resolves it as `canceled`, and the timeout fires the validator's own signal so
 * it can stop.
 */
export function executeValidator(
  validator: Validator,
  input: ValidatorInput,
  signal: AbortSignal,
  options: ValidatorExecutionOptions,
): Promise<ValidatorExecution> {
  const { runtime, timeoutMs } = options;
  const startedAt = runtime.clock.nowISO();
  return new Promise((resolve) => {
    let settled = false;
    let timer: unknown;
    const validatorController = new AbortController();
    const validatorSignal = AbortSignal.any([signal, validatorController.signal]);

    const finish = (outcome: ValidatorOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) runtime.timers.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ outcome, startedAt, completedAt: runtime.clock.nowISO() });
    };
    const onAbort = (): void => finish({ kind: 'canceled' });

    if (signal.aborted) {
      finish({ kind: 'canceled' });
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = runtime.timers.setTimeout(() => {
        finish({
          kind: 'error',
          error: {
            kind: 'timeout',
            code: 'VALIDATOR_TIMEOUT',
            message: `The validator did not settle within ${timeoutMs}ms.`,
          },
        });
        validatorController.abort('validator-timeout');
      }, timeoutMs);
    }
    const fail = (thrown: unknown): void =>
      finish({
        kind: 'error',
        error: toValidatorError(thrown, { kind: 'execute', code: 'VALIDATOR_THREW' }),
      });
    try {
      Promise.resolve(validator.validate(input, validatorSignal)).then(
        (value) => finish(normalizeValidatorOutcome(value)),
        fail,
      );
    } catch (thrown) {
      fail(thrown);
    }
  });
}
