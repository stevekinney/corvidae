import { processEnvironment } from './environment-configuration.ts';

/** Whether `pid` names a live process. Only ESRCH means it is gone; EPERM means it exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * The environment `ps` runs under: the host's own time zone and the C locale. `lstart` prints in
 * the caller's zone, and stages run with and without `TZ=UTC`, so without this a holder recorded
 * by one would look recycled to a reader in the other and lose its lock.
 */
export function processTableEnvironment(): Record<string, string | undefined> {
  const environment = Object.fromEntries(
    Object.entries(processEnvironment()).filter(([name]) => name !== 'TZ'),
  );
  return { ...environment, LC_ALL: 'C' };
}

/** The process's start time as `ps` reports it, or undefined when there is no such process. */
export function processStartTime(pid: number): string | undefined {
  const result = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], {
    env: processTableEnvironment(),
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const startedAt = result.stdout.toString().trim();
  return result.exitCode === 0 && startedAt !== '' ? startedAt : undefined;
}

/** Whether `pid` is alive and, when a start time was recorded, still the same process. */
export function isSameProcess(pid: number, startedAt: string | undefined): boolean {
  if (!isProcessAlive(pid)) return false;
  return startedAt === undefined || processStartTime(pid) === startedAt;
}

/**
 * Whether any member of the process group is alive. A process group's id is not reused while the
 * group has members, so a live group under that id is the recorded one, unless a new process now
 * leads a group with the same id, which the leader's start time exposes.
 */
export function isProcessGroupAlive(
  processGroup: number,
  leaderStartedAt: string | undefined,
): boolean {
  try {
    process.kill(-processGroup, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
  }
  if (leaderStartedAt === undefined || !isProcessAlive(processGroup)) return true;
  return processStartTime(processGroup) === leaderStartedAt;
}
