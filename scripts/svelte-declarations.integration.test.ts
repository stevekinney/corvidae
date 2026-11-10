import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { runWithHangGuard } from '../testing/testing/src/hang-guard.ts';

const root = join(import.meta.dir, '..');
const svelteCheck = join(root, 'node_modules/.bin/svelte-check');

/**
 * A fixture consumer imports `fixture-lib` by name. The package's `svelte` condition reads a
 * `.svelte` source whose `label` prop is a string, and its `types` condition reads a declaration
 * whose `label` prop is a number, so which one svelte-check reads shows in the reported error.
 * The directory lives under the repository's ignored `tmp/` so `svelte` resolves from the root.
 */
await mkdir(join(root, 'tmp'), { recursive: true });
const workspace = await mkdtemp(join(root, 'tmp', 'svelte-declarations-'));
const library = join(workspace, 'node_modules/fixture-lib');
await mkdir(library, { recursive: true });
await Bun.write(
  join(library, 'package.json'),
  JSON.stringify({
    name: 'fixture-lib',
    type: 'module',
    exports: {
      '.': {
        types: './declarations/index.d.ts',
        svelte: './Widget.svelte',
        default: './Widget.svelte',
      },
    },
  }),
);
await Bun.write(
  join(library, 'Widget.svelte'),
  `<script lang="ts">\n  let { label }: { label: string } = $props();\n</script>\n\n<p>{label}</p>\n`,
);
await mkdir(join(library, 'declarations'), { recursive: true });
await Bun.write(
  join(library, 'declarations/index.d.ts'),
  `import type { Component } from 'svelte';\ndeclare const Widget: Component<{ label: number }>;\nexport default Widget;\n`,
);
await Bun.write(
  join(workspace, 'tsconfig.json'),
  JSON.stringify({
    extends: '@lostgradient/typescript/browser.json',
    include: ['*.svelte'],
  }),
);
await Bun.write(
  join(workspace, 'Consumer.svelte'),
  `<script lang="ts">\n  import Widget from 'fixture-lib';\n</script>\n\n<Widget label="text" />\n`,
);

let result: Awaited<ReturnType<typeof runWithHangGuard>>;
try {
  result = await runWithHangGuard(
    [svelteCheck, '--output', 'machine', '--workspace', workspace, '--tsconfig', './tsconfig.json'],
    { cwd: workspace },
  );
} finally {
  await rm(workspace, { force: true, recursive: true });
}

test('svelte-check reads the declaration the types condition names, not the Svelte source', () => {
  const output = result.stdout.toString();
  // The declaration says `label` is a number, so the string the consumer passes is the error.
  // Were the `.svelte` source read, `label` would be a string and the check would pass.
  expect(output).toContain("Type 'string' is not assignable to type 'number'");
  expect(output).toMatch(/COMPLETED \d+ FILES 1 ERRORS/);
  expect(result.exitCode).toBe(1);
});
