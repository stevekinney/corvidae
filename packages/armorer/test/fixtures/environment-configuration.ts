/**
 * The one place the tool-source stdio fixture reads its process environment: it reports a variable
 * back to the test so the test can see which credential the loader put in the child's environment.
 */

/** The value of an environment variable of this process, or `undefined` when it is unset. */
export function readEnvironmentVariable(name: string): string | undefined {
  return process.env[name];
}
