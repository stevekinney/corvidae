/**
 * The stderr of a child process that boots a durable Bureau, less the one line Bureau writes by
 * design when the engine reclaims a run before composition finishes (COR-1509): Bureau holds that
 * run until composition completes and says so. A loaded host takes that path at random, so a test
 * asserting a clean child compares this, never the raw stderr, against `''`. Any other output is
 * kept and still fails the assertion.
 */
export function unexpectedChildStderr(stderr: string): string {
  return stderr.replace(COMPOSITION_HOLD_LINE, '');
}

const COMPOSITION_HOLD_LINE =
  /^\[bureau\] Run "[^"\n]+" reached recovery before the bureau finished composing; holding it until composition completes\.\n/gm;
