import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { dirname, join } from 'node:path';

const sourceRoot = dirname(import.meta.path);
const exempt = new Set(['workflow-tools.ts', 'run-authority.ts']);

function directOwnerRead(fileName: string, source: string): boolean {
  return !exempt.has(fileName) && /\bownerOf\s*\(/.test(source);
}

describe('Bureau owner-of-record authority boundary', () => {
  it('rejects a fixture tool that reads ownerOf directly', () => {
    expect(directOwnerRead('fixture-tool.ts', 'const owner = ownerOf(runId);')).toBe(true);
  });

  it('keeps direct owner reads out of Bureau tools', () => {
    const files = [...new Bun.Glob('**/*tool.ts').scanSync(sourceRoot)].map((file) =>
      file.startsWith('/') ? file : join(sourceRoot, file),
    );
    const offenders = files
      .filter((file) =>
        directOwnerRead(file.slice(sourceRoot.length + 1), readFileSync(file, 'utf8')),
      )
      .map((file) => file.slice(sourceRoot.length + 1));
    expect(offenders).toEqual([]);
  });
});
