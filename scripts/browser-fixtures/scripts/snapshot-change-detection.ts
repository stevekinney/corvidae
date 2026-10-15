/**
 * Exit 0 when the working tree has meaningful visual-baseline changes (a PNG
 * under the snapshot directory, or provenance), 1 when it has none, 2 on error.
 * Ported from cinder's `snapshot-change-detection.ts` (COR-1512).
 */
import { REPOSITORY_ROOT } from './baseline-provenance.ts';

export const SNAPSHOT_DIRECTORY = 'scripts/browser-fixtures/snapshots/';

export function extractPorcelainPath(line: string): string[] {
  const trimmed = line.slice(3).trim();
  if (trimmed.includes(' -> ')) {
    return trimmed.split(' -> ').map((path) => path.replace(/^"|"$/g, ''));
  }
  return [trimmed.replace(/^"|"$/g, '')];
}

export function isMeaningfulSnapshotPath(path: string): boolean {
  return (
    path.startsWith(SNAPSHOT_DIRECTORY) &&
    (path.endsWith('.png') || path.endsWith('/provenance.json'))
  );
}

export function hasMeaningfulSnapshotChanges(porcelain: string): boolean {
  return porcelain
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .some((line) => extractPorcelainPath(line).some(isMeaningfulSnapshotPath));
}

function readSnapshotStatus(): string {
  const result = Bun.spawnSync(
    ['git', 'status', '--porcelain', '--untracked-files=all', '--', SNAPSHOT_DIRECTORY],
    { cwd: REPOSITORY_ROOT },
  );
  if (result.exitCode !== 0) {
    throw new Error(`failed to inspect snapshot changes: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

if (import.meta.main) {
  try {
    process.exitCode = hasMeaningfulSnapshotChanges(readSnapshotStatus()) ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
