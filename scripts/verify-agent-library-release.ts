import { $ } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { libraryManifests, releaseEntries } from './agent-library-release-entries.ts';

const library = z
  .enum(['armorer', 'bungalow', 'conversationalist', 'operative'])
  .parse(process.argv[2]);
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
    const testRunner = join(import.meta.dir, 'bun-test.ts');
    await $`bun ${testRunner} ${verificationFile}`;
  } else if (library === 'operative') {
    const bunTestingEntries = new Set([
      '@lostgradient/operative/decision-testing',
      '@lostgradient/operative/provider-testing',
    ]);
    const verificationFile = join(consumer, 'verify.mjs');
    await Bun.write(
      verificationFile,
      `
      import { deepStrictEqual, strictEqual } from 'node:assert';
      import { fileURLToPath } from 'node:url';
      import { assembleBaselineArtifact, createAgent, createRunEngine, createScriptedGenerate, readReproductionArtifact, writeReproductionArtifact } from '@lostgradient/operative';
      import { workflow } from '@lostgradient/weft';
      import { MemoryStorage } from '@lostgradient/weft/storage';

      for (const specifier of ${JSON.stringify(specifiers.filter((entry) => !bunTestingEntries.has(entry)))}) {
        await import(specifier);
      }

      const generate = createScriptedGenerate([
        { kind: 'respond', response: { content: 'installed agent', toolCalls: [] } },
      ]);
      const agent = createAgent({ instructions: 'Reply with the test response.', generate });
      strictEqual((await agent.run('hello').result()).content, 'installed agent');
      generate.assertReceived(0, { tools: [] });

      const artifact = await assembleBaselineArtifact({ randomSeed: 'release-smoke' });
      const artifactPath = fileURLToPath(new URL('./artifacts/reproduction.json', import.meta.url));
      await writeReproductionArtifact(artifact, artifactPath);
      deepStrictEqual(await readReproductionArtifact(artifactPath), artifact);

      const runWorkflow = workflow({ name: 'agentRun' }).execute(async function* (_context, input) {
        return { doubled: input.value * 2 };
      });
      const { engine } = await createRunEngine({ storage: new MemoryStorage(), runWorkflow, recover: false });
      try {
        const handle = await engine.start('agentRun', { value: 21 });
        deepStrictEqual(await handle.result(), { doubled: 42 });
      } finally {
        await engine[Symbol.asyncDispose]();
      }
    `,
    );
    await $`node ${verificationFile}`.cwd(consumer);
    await $`bun ${verificationFile}`.cwd(consumer);

    const testingFile = join(consumer, 'verify-testing.test.ts');
    await Bun.write(
      testingFile,
      `
      import { expect, test } from 'bun:test';
      import { runDecisionModelContract } from '@lostgradient/operative/decision-testing';
      import { runProviderContract } from '@lostgradient/operative/provider-testing';

      test('the installed Bun testing entry points export their contracts', () => {
        expect(typeof runDecisionModelContract).toBe('function');
        expect(typeof runProviderContract).toBe('function');
      });
    `,
    );
    await $`bun ${join(import.meta.dir, 'bun-test.ts')} ${testingFile}`;

    const browserEntry = join(consumer, 'verify-browser.js');
    await Bun.write(
      browserEntry,
      "export { parseStepRowIdentifier } from '@lostgradient/operative';",
    );
    const browser = await Bun.build({ entrypoints: [browserEntry], target: 'browser' });
    if (!browser.success || browser.logs.length > 0) {
      throw new Error(browser.logs.map((log) => log.message).join('\n'));
    }
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
