import { $ } from 'bun';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sveltePlugin } from '../testing/testing/src/svelte-plugin.ts';

const [name, tarball, ...upstreamTarballs] = process.argv.slice(2);
if (!name || !['markdown', 'cinder', 'editor', 'cinder-mcp'].includes(name) || !tarball) {
  throw new Error(
    'Usage: bun scripts/verify-cinder-release.ts <package> <tarball> [upstream-tarballs...]',
  );
}
const scratch = await mkdtemp(join(tmpdir(), 'corvidae-release-consumer-'));
try {
  await Bun.write(join(scratch, 'package.json'), '{"private":true,"type":"module"}');
  await $`npm install --ignore-scripts --no-audit --no-fund ${[tarball, ...upstreamTarballs].map((file) => resolve(file))}`.cwd(
    scratch,
  );
  const consumer = join(scratch, 'verify.ts');
  await copyFile(join(import.meta.dir, 'cinder-release-consumer.ts'), consumer);
  await $`node ${consumer} ${name}`.cwd(scratch);
  if (name === 'markdown') await $`bun ${consumer} ${name}`.cwd(scratch);
  if (name === 'cinder' || name === 'editor') {
    const entry = join(scratch, 'browser.ts');
    await Bun.write(
      entry,
      name === 'cinder'
        ? 'export { Button } from "@lostgradient/cinder/button"; import "@lostgradient/cinder/styles";'
        : 'export { MarkdownEditor } from "@lostgradient/editor/markdown-editor";',
    );
    const result = await Bun.build({
      entrypoints: [entry],
      target: 'browser',
      plugins: [sveltePlugin({ generate: 'client', development: false })],
    });
    if (!result.outputs.some((output) => output.path.endsWith('.css'))) {
      throw new Error(`Browser build of ${name} did not emit CSS`);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
