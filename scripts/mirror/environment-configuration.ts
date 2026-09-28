/** Platform values allowed to reach isolated mirror Git and build subprocesses. */
export function mirrorPlatformEnvironment(
  environment: Record<string, string | undefined> = Bun.env,
): Record<string, string | undefined> {
  const names = ['HOME', 'TMPDIR', 'SYSTEMROOT', 'LANG', 'LC_ALL', 'TZ', 'PATH'];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}
