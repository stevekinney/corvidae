import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import * as terminal from './index.ts';
import { TERMINAL_ENGINE } from './terminal-engine.ts';

const packageRoot = join(import.meta.dir, '..');

type Manifest = {
  dependencies?: Record<string, string>;
  catalog?: Record<string, string>;
};

async function readManifest(path: string): Promise<Manifest> {
  return Bun.file(path).json();
}

describe('package entry', () => {
  test('exports the engine identity and no Terminal component before COR-478', () => {
    expect(Object.keys(terminal)).toEqual(['TERMINAL_ENGINE']);
    expect(terminal.TERMINAL_ENGINE).toBe(TERMINAL_ENGINE);
  });

  test('names the engine the root catalog pins and this package depends on', async () => {
    const root = await readManifest(join(packageRoot, '../../package.json'));
    const own = await readManifest(join(packageRoot, 'package.json'));
    expect(root.catalog?.[TERMINAL_ENGINE.packageName]).toBe(TERMINAL_ENGINE.version);
    expect(own.dependencies?.[TERMINAL_ENGINE.packageName]).toBe('catalog:');
  });
});
