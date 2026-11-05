/**
 * The stderr of a child process that boots a durable Bureau, less the lines Bureau writes by
 * design when the engine reclaims a run before composition finishes (COR-1509): Bureau holds that
 * run until composition completes and says so. COR-1586 likewise holds a run until its catalog
 * resolver is wired. A loaded host takes these paths at random, so a test
 * asserting a clean child compares this, never the raw stderr, against `''`. Any other output is
 * kept and still fails the assertion.
 */
export function unexpectedChildStderr(stderr: string): string {
  return stderr.replace(COMPOSITION_HOLD_LINE, '').replace(CATALOG_HOLD_LINE, '');
}

const COMPOSITION_HOLD_LINE =
  /^\[bureau\] Run "[^"\n]+" reached recovery before the bureau finished composing; holding it until composition completes\.\n/gm;

const CATALOG_HOLD_LINE =
  /^\[bureau\] Run "[^"\n]+" needs the agent run options resolver before the bureau has wired it; holding it until the bureau finishes building its agent catalog\.\n/gm;
