import { copyFile, lstat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Only these synthetic receipts may leave the runner; homes and command output never do. */
export const RECOVERY_EVIDENCE_FILES = [
  'artifacts.txt',
  'node-version.txt',
  'npm-version.txt',
  'rehearsal/installed-artifacts.json',
  'rehearsal/before-manifest.json',
  'rehearsal/after-upgrade-manifest.json',
  'rehearsal/recovery-receipt.json',
  'rehearsal/diagnostics.json',
] as const;

export async function stageRecoveryEvidence(source: string, destination: string): Promise<void> {
  const root = await lstat(source);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Unsafe evidence source');
  await mkdir(destination, { recursive: false });
  for (const path of RECOVERY_EVIDENCE_FILES) {
    const input = join(source, path);
    let entry;
    try {
      if (path.startsWith('rehearsal/')) {
        const parent = await lstat(join(source, 'rehearsal'));
        if (!parent.isDirectory() || parent.isSymbolicLink())
          throw new Error('Unsafe rehearsal directory');
      }
      entry = await lstat(input);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error(`Unsafe evidence entry: ${path}`);
    const output = join(destination, path);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(input, output);
  }
}

if (import.meta.main) {
  const [source, destination] = Bun.argv.slice(2);
  if (!source || !destination) throw new Error('Expected evidence source and fresh destination');
  await stageRecoveryEvidence(source, destination);
}
