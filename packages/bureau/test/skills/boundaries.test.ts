// Skills is a self-contained subsystem inside Bureau: discovery, admission, the skill client, and
// self-improvement depend only on the tool, storage, and utility layers beneath Bureau. Keeping
// it off Operative, Memory, and the rest of Bureau keeps it a unit that Bureau composes in
// `agent-skills.ts` rather than something tangled through Bureau's runtime.

import { describe, expect, it } from 'bun:test';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

import ts from 'typescript';

const skillsDirectory = resolve(import.meta.dir, '../../src/skills');
const allowedPackages = new Set([
  'armorer',
  'armorer/protocol',
  '@lostgradient/cryptography',
  '@lostgradient/lifecycle',
  '@lostgradient/storage',
  '@lostgradient/weft',
  'gray-matter',
  'js-yaml',
  'zod',
]);

describe('skills subsystem boundary', () => {
  it('imports only its own files and the layers beneath Bureau', async () => {
    const offending: string[] = [];
    for await (const file of new Bun.Glob('**/*.ts').scan(skillsDirectory)) {
      const source = await Bun.file(join(skillsDirectory, file)).text();
      // `preProcessFile` reads real import and export declarations, type-only ones included, and
      // ignores specifier-shaped text inside comments and strings.
      for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(join(skillsDirectory, file)), specifier);
          if (relative(skillsDirectory, target).startsWith('..')) {
            offending.push(`${file} -> ${specifier}`);
          }
        } else if (!isBuiltin(specifier) && !allowedPackages.has(specifier)) {
          offending.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });
});
