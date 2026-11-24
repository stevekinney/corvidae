import { $ } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { libraryManifests, releaseEntries } from './agent-library-release-entries.ts';

const library = z.enum(['armorer', 'bungalow', 'conversationalist']).parse(process.argv[2]);
const tarballs = process.argv.slice(3).map((file) => resolve(file));
if (tarballs.length < 1 || tarballs.length > 2) {
  throw new Error('Pass the package tarball and optionally its Armorer dependency tarball');
}

const consumer = await mkdtemp(join(tmpdir(), 'corvidae-agent-library-consumer-'));
try {
  await Bun.write(join(consumer, 'package.json'), '{"private":true,"type":"module"}');
  await $`npm install --ignore-scripts --no-audit --no-fund ${tarballs}`.cwd(consumer);
  const packageName = libraryManifests[library].name;
  const specifiers = Object.keys(releaseEntries[library]).map(
    (entry) => packageName + entry.slice(1),
  );
  if (library === 'bungalow') {
    const verificationFile = join(consumer, 'verify.test.ts');
    await Bun.write(
      verificationFile,
      `
      import { expect, test } from 'bun:test';
      import { existsSync } from 'node:fs';
      import { dirname } from 'node:path';
      import { openTemporaryBungalow } from '@lostgradient/bungalow';
      import { checkBungalow } from '@lostgradient/bungalow/conformance';

      test('the installed package opens and cleans up a local home', async () => {
        const home = await openTemporaryBungalow({ name: 'release-smoke' });
        if (home.database.kind !== 'sqlite') {
          home.close();
          throw new Error('Local Bungalow did not expose a SQLite location');
        }
        const root = dirname(home.database.path);
        try {
          expect(typeof checkBungalow).toBe('function');
          expect(existsSync(root)).toBe(true);
        } finally {
          home.close();
        }
        expect(existsSync(root)).toBe(false);
      });
    `,
    );
    await $`bun test ${verificationFile}`.cwd(consumer);
  } else {
    const tests = [
      ...specifiers.map((specifier) => `await import(${JSON.stringify(specifier)});`),
      library === 'armorer'
        ? `import { createTool as root } from 'armorer';
         import { createTool as lazy } from 'armorer/lazy';
         if (root !== lazy) throw new Error('Armorer entry points created distinct tool factories');`
        : `import { materializeToolResult as owner } from 'armorer/protocol';
         import { materializeToolResult as shared } from 'conversationalist/conversation';
         if (owner !== shared) throw new Error('Conversationalist duplicated the Armorer protocol');`,
    ];
    const verificationFile = join(consumer, 'verify.mjs');
    await Bun.write(verificationFile, tests.join('\n'));
    await $`node ${verificationFile}`.cwd(consumer);
    await $`bun ${verificationFile}`.cwd(consumer);
    const browserEntry = join(consumer, 'browser.js');
    await Bun.write(browserEntry, `export * from ${JSON.stringify(library)};`);
    await Bun.build({ entrypoints: [browserEntry], target: 'browser' });
  }
} finally {
  await rm(consumer, { recursive: true, force: true });
}
