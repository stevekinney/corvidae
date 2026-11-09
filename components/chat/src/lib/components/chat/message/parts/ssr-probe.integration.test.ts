import {
  importSvelteOnServer,
  outcomeOf,
  prepareSvelteServerSource,
  rethrow,
} from '@lostgradient/testing';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const serverSourcePaths = [
  resolve(import.meta.dir, '..', 'chat-message-parts-renderer.svelte'),
  resolve(import.meta.dir, 'reasoning-part.svelte'),
  resolve(import.meta.dir, 'step-part.svelte'),
  resolve(import.meta.dir, 'tool-approval-part.svelte'),
  resolve(import.meta.dir, 'suggestion-part.svelte'),
];

await Promise.all(serverSourcePaths.map((sourcePath) => prepareSvelteServerSource(sourcePath)));

// Each probe is a real DOM-free server process, so they run here at module scope, off the
// per-test clock, and every test rethrows whatever its scenario threw.
const utilitiesImport = await outcomeOf(async () => {
  // Resolve to an absolute path here (not in the shared helper) so the dynamic
  // import inside the helper doesn't resolve the specifier relative to its own
  // module location.
  const utilitiesPath = resolve(import.meta.dir, '..', '..', 'utilities', 'utilities.ts');
  const utilitiesUrl = pathToFileURL(utilitiesPath).href;
  const probe = spawnWithHangGuard(
    [
      process.execPath,
      '-e',
      [
        "Reflect.deleteProperty(globalThis, 'document');",
        "Reflect.deleteProperty(globalThis, 'window');",
        `await import(${JSON.stringify(utilitiesUrl)});`,
      ].join(''),
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  );

  const [exitCode, stderr] = await Promise.all([probe.exited, new Response(probe.stderr).text()]);

  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
});

const [partsRenderer, reasoningPart, stepPart, toolApprovalPart, suggestionPart] =
  await Promise.all(
    serverSourcePaths.map((sourcePath) => outcomeOf(() => importSvelteOnServer(sourcePath))),
  );

describe('parts spine — SSR safety', () => {
  test('deriveMessageParts imports with no DOM globals at module level', () =>
    rethrow(utilitiesImport));

  test('server compilation of the parts renderer imports with no DOM globals at module level', () =>
    rethrow(partsRenderer));

  test('(C4) reasoning-part.svelte imports with no DOM globals at module level', () =>
    rethrow(reasoningPart));

  test('(C4) step-part.svelte imports with no DOM globals at module level', () =>
    rethrow(stepPart));

  test('tool-approval-part.svelte imports with no DOM globals at module level', () =>
    rethrow(toolApprovalPart));

  test('(C5) suggestion-part.svelte imports with no DOM globals at module level', () =>
    rethrow(suggestionPart));
});
