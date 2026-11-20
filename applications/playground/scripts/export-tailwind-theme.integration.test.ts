import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cinderThemeBase } from '../src/shell-app/theme-builder-base.ts';
import { applyEdit, createDraft } from '../src/shell-app/theme-draft.ts';
import { createEnvelope, envelopeDownload } from '../src/shell-app/theme-envelope.ts';
import { planExports } from '../src/shell-app/theme-export-plan.ts';
import { takeExportSnapshot } from '../src/shell-app/theme-export-snapshot.ts';
import { createRuntimeEvaluator } from '../src/shell-app/theme-runtime-evaluator.ts';

const edit = applyEdit(createDraft(createEnvelope('parity', 'CLI parity', cinderThemeBase())), {
  kind: 'set-override',
  scope: 'dark',
  path: 'radius.medium',
  node: { $type: 'dimension', $value: { value: 19, unit: 'px' } },
});
if (!edit.ok || !edit.changed) throw new Error('The test theme edit was rejected.');

const snapshot = await takeExportSnapshot(edit.draft, createRuntimeEvaluator());
const expected = planExports(snapshot, true).artifacts.find(({ kind }) => kind === 'tailwind');

const { withheld, samePath, malformed, exported, css, heldCss, malformedCss } = await (async () => {
  const directory = await mkdtemp(join(tmpdir(), 'playground-tailwind-export-'));
  const source = join(directory, 'source.json');
  const output = join(directory, 'theme.css');
  const cli = join(import.meta.dir, 'export-tailwind-theme.ts');
  const run = (argumentsList: string[]) =>
    runWithHangGuard([process.execPath, cli, ...argumentsList], { cwd: directory });
  try {
    await Bun.write(source, envelopeDownload(edit.draft.envelope).text);
    await Bun.write(output, 'existing output');
    const withheld = await run([source, output]);
    const heldCss = await Bun.file(output).text();
    const samePath = await run(['--acknowledge', source, source]);
    const exported = await run(['--acknowledge', source, output]);
    const css = await Bun.file(output).text();
    const broken = join(directory, 'broken.json');
    await Bun.write(broken, '{');
    const malformed = await run(['--acknowledge', broken, output]);
    const malformedCss = await Bun.file(output).text();
    return { withheld, samePath, malformed, exported, css, heldCss, malformedCss };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();

test('CLI writes the same CSS as the browser for the exported source of an edited revision', () => {
  const browserFile = expected?.files[0];
  if (expected?.available !== true || browserFile === undefined)
    throw new Error(expected?.blockedReason ?? 'Missing browser export.');
  expect(exported.exitCode, exported.stderr.toString()).toBe(0);
  expect(css).toBe(browserFile.text);
  expect(css).toContain('--cinder-radius-md: 19px;');
  expect(css).toContain('--radius-medium: var(--cinder-radius-md);');
});

test('CLI protects the source and preserves existing output when validation blocks export', () => {
  expect(withheld.exitCode).toBe(1);
  expect(withheld.stderr.toString()).toContain('acknowledgement');
  expect(heldCss).toBe('existing output');
  expect(samePath.exitCode).toBe(1);
  expect(samePath.stderr.toString()).toContain('separate from the source JSON');
  expect(malformed.exitCode).toBe(1);
  expect(malformedCss).toBe(css);
});
