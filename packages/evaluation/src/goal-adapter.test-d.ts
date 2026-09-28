// Compile-time tripwire, checked by `typecheck` (`tsc --noEmit`): the goal
// evaluator adapter's verdict must speak COR-638's validator vocabulary
// exactly. COR-638 ("Define managed goal and validation semantics", Done
// 2026-09-20) fixes these unions as text in its decision record; no workspace
// exports them as types, so they are copied verbatim below as local types
// rather than imported. If either the adapter or COR-638's closed unions
// change without the other, this file stops compiling.

import type { GoalEvaluatorVerdict } from './index';

// ---- Copied verbatim from COR-638's "Validator contract (AC2)". ----

type ValidatorOutcome =
  | { readonly kind: 'pass'; readonly evidence: readonly ValidatorEvidence[] }
  | {
      readonly kind: 'fail';
      readonly feedback: string; // structured, attempt-actionable—never a bare boolean
      readonly evidence: readonly ValidatorEvidence[];
      readonly retryable: boolean; // this attempt's failure kind is one the goal's retry policy may act on
    }
  | { readonly kind: 'error'; readonly error: ValidatorError } // infrastructure failure, see AC1
  | { readonly kind: 'unavailable'; readonly error: ValidatorError; readonly reason: string } // validator could not be reached/started at all
  | { readonly kind: 'canceled' } // validation was aborted mid-run, distinct from 'error'
  | { readonly kind: 'indeterminate'; readonly reason: string }; // validator ran but could not reach pass/fail (e.g. ambiguous evidence)

type ValidatorErrorKind = 'load' | 'contract' | 'execute' | 'timeout' | 'output';

interface ValidatorError {
  readonly kind: ValidatorErrorKind;
  readonly code: string;
  readonly message: string;
  readonly cause?: unknown;
}

interface ValidatorEvidence {
  readonly source: string; // e.g. 'test-run', 'file-diff', 'command-exit-code'
  readonly detail: unknown; // opaque to the goal controller; validator-owned shape
}

// ---- Assertions. ----

/** True only when `A` and `B` are the identical type, not merely mutually assignable. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type VerdictError = Extract<GoalEvaluatorVerdict, { readonly error: unknown }>['error'];

// `GoalEvaluatorVerdict['kind']` is exactly COR-638's `ValidatorOutcome` kind union.
const verdictKindsMatch: Equal<GoalEvaluatorVerdict['kind'], ValidatorOutcome['kind']> = true;

// The verdict's `error.kind` is exactly COR-638's `ValidatorErrorKind`.
const errorKindsMatch: Equal<VerdictError['kind'], ValidatorErrorKind> = true;

// Every verdict error is a COR-638 `ValidatorError`, so a goal controller can forward it unchanged.
const verdictError: ValidatorError = {} as VerdictError;

void verdictKindsMatch;
void errorKindsMatch;
void verdictError;
