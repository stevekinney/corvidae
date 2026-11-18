import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { LOCK_FILES, unexplainedCatches } from './check-swallowed-catches';

describe('swallowed catches in the lock code (COR-2463)', () => {
  test('flags a bare catch whose block does not open with a reason', () => {
    const source = ['try {', '  await rmdir(path);', '} catch {', '  return false;', '}'].join(
      '\n',
    );
    expect(unexplainedCatches(source)).toEqual([3]);
  });

  test('accepts a bare catch that explains itself, and a bound catch', () => {
    const source = [
      '} catch {',
      '  // The group has exited.',
      '}',
      '} catch (error) {',
      "  if (errorCode(error) === 'ENOENT') return undefined;",
      '  throw error;',
      '}',
    ].join('\n');
    expect(unexplainedCatches(source)).toEqual([]);
  });

  test('every bare catch in the lock files says why it is safe', async () => {
    const root = join(import.meta.dir, '..');
    for (const file of LOCK_FILES) {
      const handle = Bun.file(join(root, file));
      if (await handle.exists()) expect(unexplainedCatches(await handle.text()), file).toEqual([]);
    }
  });
});
