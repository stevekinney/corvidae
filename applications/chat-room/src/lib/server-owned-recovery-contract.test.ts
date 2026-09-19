import { describe, expect, test } from 'bun:test';

import type { AgentRun, DiagnosticAgentRun, SessionHandle } from '@corvidae/operative';

/**
 * What the published Operative types actually say about a recovered run.
 *
 * CIN-445 asked for the step-level-progress claim to be "enforced by the
 * published types", on the premise that a recovered run is a
 * `DiagnosticAgentRun` which "deliberately omits the `output()` and `unwrap()`
 * accessors". Checking that against `0.11.0` turned up three things:
 *
 *   1. `SessionHandle.recover()` is declared `Promise<AgentRun | null>`. The
 *      recovered handle is wrapped with `createAgentRun`, not
 *      `createDiagnosticAgentRun` — upstream's own comment beside the call says
 *      "wrap it as an `AgentRun` so the caller can observe the resumed run
 *      normally". The narrowing the criterion relies on is not on this path.
 *   2. `output()` is absent from `AgentRun` at the default `H = false` anyway
 *      (`OutputMethod<O, H>` resolves to `Record<never, never>`), so half the
 *      premise describes a distinction that does not exist here.
 *   3. `DiagnosticAgentRun` does omit both accessors. Its `closed()` also
 *      downgrades a wrapped `'completed'` to `{ status: 'unresolved', reason:
 *      'unknown-effect' }`, because durability is undeterminable from a
 *      recovered wrapper. That documented distinction is intentionally
 *      described here but is not claimed as a contract pinned by this file;
 *      the tests below pin only the members they read.
 *
 * TYPE-LEVEL, in a file `bun run check` compiles, because the sentence these
 * replace was wrong for two minor versions before anyone checked it. The
 * assertions below specifically pin `recover()`'s `unwrap()` return type,
 * `DiagnosticAgentRun`'s missing `unwrap()` and `output()`, and both shapes'
 * `result()` member.
 *
 * DIRECTIONAL, and that is the second attempt. The first wrote a mutual
 * `Exact<Left, Right>` assignability helper, which passed with the claim
 * deliberately inverted: `AgentRun<never, false>` and `DiagnosticAgentRun` are
 * mutually assignable as far as TypeScript is concerned, so an equality helper
 * over them reports `true` either way and pins nothing. Each test below either
 * reads one of those members or carries a
 * `@ts-expect-error` that fails the build the moment the error it expects stops
 * happening. Both forms were proved by inverting them and watching `bun run
 * check` fail.
 */

type Recovered = NonNullable<Awaited<ReturnType<SessionHandle['recover']>>>;
type Unwrapped = ReturnType<Recovered['unwrap']>;

function diagnosticUnwrap(run: DiagnosticAgentRun): unknown {
  // @ts-expect-error `unwrap` is deliberately deleted from a diagnostic run:
  // its originating schema may no longer be available to validate against.
  return run.unwrap;
}

function diagnosticOutput(run: DiagnosticAgentRun): unknown {
  // @ts-expect-error same deletion, same reason.
  return run.output;
}

function untypedRunOutput(run: AgentRun): unknown {
  // @ts-expect-error not present at the default `H = false`.
  return run.output;
}

const handleStandIn: Partial<SessionHandle> = {};
const diagnosticStandIn: Partial<Record<'output' | 'unwrap' | 'result', unknown>> = {};
const liveStandIn: Partial<Record<'output', unknown>> = {};

describe('the published shape of a recovered run', () => {
  test('recover() hands back a handle that still has unwrap(), so it is not a DiagnosticAgentRun', async () => {
    // `unwrap()` is the accessor the two shapes genuinely differ on. Reading
    // it off `recover()`'s result is what pins the declared return type: were
    // upstream to narrow `recover()` to `DiagnosticAgentRun | null`, this line
    // would stop compiling and the recovery endpoint's comment about
    // step-level progress would need to cite the narrowing rather than the
    // checkpoint.
    //
    // Never CALLED — `handle` is a declared type, with no implementation
    // behind it. The assertion is that the expression type-checks.
    const unwrapReturnsText: Unwrapped extends Promise<string> ? true : false = true;
    expect(unwrapReturnsText).toBe(true);
    // The stand-in carries no members, which is the whole reason it is safe
    // to read off: the claim lives in the types above, not in this object.
    expect(handleStandIn.recover).toBeUndefined();
  });

  test('a DiagnosticAgentRun offers no unwrap()', () => {
    expect(diagnosticUnwrap).toBeFunction();
    expect(diagnosticStandIn.unwrap).toBeUndefined();
  });

  test('a DiagnosticAgentRun offers no output()', () => {
    expect(diagnosticOutput).toBeFunction();
    expect(diagnosticStandIn.output).toBeUndefined();
  });

  test('output() is absent from an untyped AgentRun too, so its absence is not the distinction', () => {
    // The half of CIN-445's premise that turned out vacuous. `AgentRun`'s
    // defaults are `<O = never, H extends boolean = false>` and `output()`
    // exists only at `H = true`, so a consumer holding `recover()`'s result
    // could not have called it on either shape.
    expect(untypedRunOutput).toBeFunction();
    expect(liveStandIn.output).toBeUndefined();
  });

  test('both shapes answer result(), which is what a recovery surface would read', () => {
    // Neither handle is useless after recovery. The diagnostic one widens its
    // output to `unknown`, which is the honest consequence of not being able
    // to validate against the originating schema.
    type LiveResult = AgentRun['result'];
    type DiagnosticResult = DiagnosticAgentRun['result'];
    const bothExposeResults: LiveResult extends () => unknown
      ? DiagnosticResult extends () => unknown
        ? true
        : false
      : false = true;
    expect(bothExposeResults).toBe(true);
    expect(diagnosticStandIn.result).toBeUndefined();
  });
});
