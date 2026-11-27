/** The process environment this library hands to `ps` and to the processes it starts. */
export function processEnvironment(): Record<string, string | undefined> {
  return process.env;
}
