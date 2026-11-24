/**
 * The generated Bureau client (`src/lib/generated/`) is exactly what `scripts/generate-bureau-client.ts`
 * writes from the operations the Bureau handler serves. It lives under `src/host` because the
 * generator formats with Prettier, which the browser lane resolves to its standalone build.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG_OPERATION_BEHAVIORS } from '../lib/generated/operation-behaviors.generated.ts';

import {
  BUREAU_CLIENT_DIRECTORY,
  BUREAU_CLIENT_FILE,
  createBureauClientSources,
  runGenerateBureauClientCommand,
} from '../../scripts/generate-bureau-client.ts';

describe('the generated Bureau client', () => {
  it('retains the Reviews observation metadata in the generated descriptor', () => {
    expect(CATALOG_OPERATION_BEHAVIORS['bureau.reviews.resolve'].behavior.conflictReasons).toEqual([
      'REVIEW_ROUND_CHANGED',
      'REVIEW_ALREADY_RESOLVED',
      'APPROVAL_OUTCOME_NOT_WRITTEN',
    ]);
    expect(
      CATALOG_OPERATION_BEHAVIORS['bureau.reviews.resolve'].behavior.observedInput,
    ).toMatchObject({ read: 'bureau.reviews.get', key: 'id', revision: 'round' });
  });
  it('is what the generator writes now, file for file', async () => {
    const sources = await createBureauClientSources();
    const files = await readdir(BUREAU_CLIENT_DIRECTORY);
    const committed = files.toSorted();

    expect(committed).toEqual([...sources.keys()].toSorted());
    for (const [fileName, source] of sources) {
      const text = await Bun.file(join(BUREAU_CLIENT_DIRECTORY, fileName)).text();
      // A failure here means a Bureau operation changed: run `bun run generate:bureau-client`.
      expect(text, fileName).toBe(source);
    }
  });

  it('names a method for each unary operation and a subscription method for the three feeds', async () => {
    const sources = await createBureauClientSources();
    const main = sources.get(BUREAU_CLIENT_FILE) ?? '';

    expect(main).toContain("'bureau.skills.list'");
    expect(main).toContain("'bureau.tasks.events'");
    expect(main).toContain('export function createBureauClient(');
    expect(main).toContain("'/bureau/v1/subscriptions'");
  });

  it('writes every file to the directory it is given, and the same bytes twice', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'generate-bureau-client-'));
    try {
      const lines: string[] = [];
      await runGenerateBureauClientCommand(['--output-directory', directory], (line) =>
        lines.push(line),
      );
      const first = await Bun.file(join(directory, BUREAU_CLIENT_FILE)).text();
      await runGenerateBureauClientCommand(['--output-directory', directory], () => undefined);

      const sources = await createBureauClientSources();
      const second = await Bun.file(join(directory, BUREAU_CLIENT_FILE)).text();

      expect(lines).toHaveLength(sources.size);
      expect(second).toBe(first);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
