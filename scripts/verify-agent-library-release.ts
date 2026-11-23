import { $ } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { releaseEntries } from './agent-library-release-entries.ts';

const library = z.enum(['armorer', 'conversationalist']).parse(process.argv[2]);
const tarballs = process.argv.slice(3).map((file) => resolve(file));
if (tarballs.length < 1 || tarballs.length > 2) {
  throw new Error('Pass the package tarball and optionally its Armorer dependency tarball');
}

const consumer = await mkdtemp(join(tmpdir(), 'corvidae-agent-library-consumer-'));
try {
  await Bun.write(join(consumer, 'package.json'), '{"private":true,"type":"module"}');
  await $`npm install --ignore-scripts --no-audit --no-fund ${tarballs}`.cwd(consumer);
  const specifiers = Object.keys(releaseEntries[library]).map((entry) => library + entry.slice(1));
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
  await Bun.write(join(consumer, 'verify.mjs'), tests.join('\n'));
  await $`node verify.mjs`.cwd(consumer);
  await $`bun verify.mjs`.cwd(consumer);
  const browserEntry = join(consumer, 'browser.js');
  await Bun.write(browserEntry, `export * from ${JSON.stringify(library)};`);
  await Bun.build({ entrypoints: [browserEntry], target: 'browser' });
} finally {
  await rm(consumer, { recursive: true, force: true });
}
