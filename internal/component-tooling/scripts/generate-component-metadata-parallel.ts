/** Two isolated, sequential schema generators for a component package's metadata task. */
import { join } from 'node:path';
import { z } from 'zod';
import type { DiscoveredComponent } from './discover-component-directories.ts';

const resultSchema = z.object({
  name: z.string(),
  schema: z.record(z.string(), z.unknown()),
  variables: z.array(z.string()),
});
export type ComponentMetadataResult = z.infer<typeof resultSchema>;

/** Divide the already-sorted components evenly without changing their order within a batch. */
export function partitionComponents<T>(components: readonly T[]): [T[], T[]] {
  const batches: [T[], T[]] = [[], []];
  components.forEach((component, index) => batches[index % 2]!.push(component));
  return batches;
}

/** Refuse incomplete, duplicate or unexpected results, then restore discovery order. */
export function orderMetadataResults(
  expected: readonly string[],
  results: readonly ComponentMetadataResult[],
): ComponentMetadataResult[] {
  const byName = new Map(results.map((result) => [result.name, result]));
  if (
    byName.size !== results.length ||
    byName.size !== expected.length ||
    new Set(expected).size !== expected.length ||
    expected.some((name) => !byName.has(name))
  ) {
    throw new Error('Metadata workers returned an incomplete or duplicate component set');
  }
  return expected.map((name) => byName.get(name)!);
}

/** Run both owned workers to settlement, cancelling their siblings on failure or interruption. */
export async function generateComponentMetadataInWorkers(
  components: readonly DiscoveredComponent[],
): Promise<ComponentMetadataResult[]> {
  const children: Array<ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'inherit'>>> = [];
  let interrupted = false;
  const stopErrors: unknown[] = [];
  const stopChild = (child: (typeof children)[number]) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
        stopErrors.push(error);
    }
  };
  const stop = () => {
    if (interrupted) return;
    interrupted = true;
    for (const child of children) stopChild(child);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    for (const batch of partitionComponents(components)) {
      children.push(
        Bun.spawn(
          [
            process.execPath,
            '--no-install',
            join(import.meta.dir, 'generate-component-metadata-worker.ts'),
            JSON.stringify(batch),
          ],
          {
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'inherit',
          },
        ),
      );
    }
    const results = await Promise.all(
      children.map(async (child) => {
        const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
        if (code !== 0) throw new Error(`Component metadata worker exited ${code}`);
        return z.array(resultSchema).parse(JSON.parse(text));
      }),
    );
    if (interrupted) throw new Error('Component metadata generation was interrupted');
    return orderMetadataResults(
      components.map(({ name }) => name),
      results.flat(),
    );
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    for (const child of children) {
      stopChild(child);
      try {
        void child.stdin.end();
      } catch {
        /* A completed worker has already closed its pipe. */
      }
    }
    await Promise.all(children.map((child) => child.exited));
    await reportStopErrors(stopErrors);
  }
}

async function reportStopErrors(errors: readonly unknown[]): Promise<void> {
  if (errors.length > 0) throw new AggregateError(errors, 'Could not stop every metadata worker');
}
