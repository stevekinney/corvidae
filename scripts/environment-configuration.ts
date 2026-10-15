/** The process environment that root repository scripts read and pass on to the commands they run. */
export function rootScriptEnvironment(): Record<string, string | undefined> {
  return process.env;
}
