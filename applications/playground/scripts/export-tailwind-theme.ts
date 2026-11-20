import { statSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { ensureCinderGenerated } from '../../../scripts/ensure-cinder-generated.ts';
import { THEME_DATA_LIMITS } from '../src/shell-app/theme-draft-limits.ts';
import { createDraft } from '../src/shell-app/theme-draft.ts';
import { parseThemeEnvelope } from '../src/shell-app/theme-envelope.ts';

const help = `Usage: bun applications/playground/scripts/export-tailwind-theme.ts [--acknowledge] <theme.json> <theme.css>

Reads Cinder Theme v1 source JSON and writes Tailwind v4 CSS.
--acknowledge    Confirm that you reviewed the theme's advisory and needs-review findings.
--help           Show this help.
`;

async function main(argumentsList: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argumentsList,
    allowPositionals: true,
    options: {
      acknowledge: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  const [input, output] = positionals;
  if (positionals.length !== 2 || input === undefined || output === undefined) {
    throw new Error(help.trimEnd());
  }
  const inputPath = resolve(input);
  const outputPath = resolve(output);
  const inputStatus = statSync(inputPath);
  if (!inputStatus.isFile()) throw new Error('The theme input must be a regular file.');
  if (inputStatus.size > THEME_DATA_LIMITS.fileBytes) throw new Error('The file is over 1 MiB.');
  const outputStatus = statSync(outputPath, { throwIfNoEntry: false });
  if (outputStatus?.dev === inputStatus.dev && outputStatus.ino === inputStatus.ino) {
    throw new Error('Choose an output path separate from the source JSON.');
  }

  const parsed = parseThemeEnvelope(await Bun.file(inputPath).text());
  if (!parsed.ok) throw new Error(parsed.message);

  // A CLI invocation can bypass Turbo's generated-artifact dependencies.
  ensureCinderGenerated();
  const { planTailwindExport } = await import('../src/shell-app/theme-export-plan.ts');
  const { takeExportSnapshot } = await import('../src/shell-app/theme-export-snapshot.ts');
  const { createRuntimeEvaluator } = await import('../src/shell-app/theme-runtime-evaluator.ts');
  const snapshot = await takeExportSnapshot(createDraft(parsed.envelope), createRuntimeEvaluator());
  const artifact = planTailwindExport(snapshot, values.acknowledge === true);
  const file = artifact.files[0];
  if (file === undefined)
    throw new Error(artifact.blockedReason ?? 'The theme could not be exported.');

  const temporaryDirectory = await mkdtemp(join(dirname(outputPath), '.tailwind-theme-'));
  try {
    const temporaryFile = join(temporaryDirectory, 'theme.css');
    await Bun.write(temporaryFile, file.text);
    await rename(temporaryFile, outputPath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
