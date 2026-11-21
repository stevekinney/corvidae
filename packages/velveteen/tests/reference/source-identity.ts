/** Require a clean checkout before using its files as the pinned behavioral specification. */
export function assertCleanSource(
  directory: string,
  expectedCommit?: string,
): void {
  const status = Bun.spawnSync([
    "git",
    "-C",
    directory,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.exitCode !== 0 || status.stdout.toString().trim() !== "") {
    throw new Error(
      `reference checkout is not clean: ${status.stdout.toString()}${status.stderr.toString()}`,
    );
  }
  if (expectedCommit) {
    const head = Bun.spawnSync(["git", "-C", directory, "rev-parse", "HEAD"]);
    if (head.exitCode !== 0 || head.stdout.toString().trim() !== expectedCommit)
      throw new Error(`reference checkout does not match ${expectedCommit}`);
  }
}
