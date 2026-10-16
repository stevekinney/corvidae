import { afterAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_SKILLS_SPECIFICATION_REPOSITORY,
  AGENT_SKILLS_SPECIFICATION_REVISION,
} from '../../src/skills/conformance';
import { readEnvironmentVariable } from '../../src/skills/environment-configuration';
import { parseSkillMarkdown } from '../../src/skills/parse-skill-markdown';
import { CONFORMANCE_CORPUS } from './fixtures/agent-skills-corpus';

/**
 * Cross-checks the pinned corpus against the *actual* official reference validator.
 *
 * This is deliberately opt-in. The reference validator is a Python package, and this workspace is
 * Bun-only: wiring it into the default suite would put a hard `uv`/Python dependency on
 * `bun run validate`, which every contributor and every worktree would then need. The repository
 * already has this shape of gate — the real-browser smoke suites behind `WEFT_BROWSER_SMOKE` — and
 * this follows it.
 *
 * The corpus itself is checked unconditionally in `conformance.test.ts`. What this adds is proof
 * that the corpus's own expectations match upstream rather than merely matching this package.
 *
 * Run it with the pinned validator fetched on demand:
 *
 * ```sh
 * AGENT_SKILLS_REFERENCE_VALIDATOR=uvx bun test packages/bureau/test/skills/conformance-reference.test.ts
 * ```
 *
 * Or point it at an already-installed executable:
 *
 * ```sh
 * AGENT_SKILLS_REFERENCE_VALIDATOR=skills-ref bun test packages/bureau/test/skills/conformance-reference.test.ts
 * ```
 */
function resolveValidatorCommand(): string[] | undefined {
  const configured = readEnvironmentVariable('AGENT_SKILLS_REFERENCE_VALIDATOR');
  if (configured === undefined || configured.trim() === '') return undefined;

  if (configured === 'uvx') {
    // Pinned at the exact revision this package claims conformance with, so the cross-check cannot
    // silently drift onto a newer upstream.
    const specifier = `git+${AGENT_SKILLS_SPECIFICATION_REPOSITORY}@${AGENT_SKILLS_SPECIFICATION_REVISION}#subdirectory=skills-ref`;
    return ['uvx', '--from', specifier, 'skills-ref'];
  }

  return configured.split(/\s+/u).filter((part) => part !== '');
}

const validatorCommand = resolveValidatorCommand();
const createdRoots: string[] = [];

afterAll(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function materialize(directoryName: string, skillMarkdown: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-skills-ref-'));
  createdRoots.push(root);
  const skillDirectory = join(root, directoryName);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, 'SKILL.md'), skillMarkdown);
  return skillDirectory;
}

/**
 * The reference validator is a real process, so every fixture runs through it once here at module
 * scope to stay off the per-test clock. The guard is the same opt-in as the suite below: with
 * `AGENT_SKILLS_REFERENCE_VALIDATOR` unset, nothing is spawned.
 */
const referenceExitCodes = new Map<string, number>();
if (validatorCommand !== undefined) {
  for (const fixture of CONFORMANCE_CORPUS) {
    const skillDirectory = await materialize(fixture.directoryName, fixture.skillMarkdown);
    const child = Bun.spawn([...validatorCommand, 'validate', skillDirectory], {
      timeout: 120_000,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    referenceExitCodes.set(fixture.id, await child.exited);
  }
}

describe.skipIf(validatorCommand === undefined)(
  'the official reference validator agrees with this package',
  () => {
    for (const fixture of CONFORMANCE_CORPUS) {
      it(`agrees on ${fixture.id}`, () => {
        if (validatorCommand === undefined) return;

        // -1 stands for a validator that never reported a code, which the check below rejects.
        const exitCode = referenceExitCodes.get(fixture.id) ?? -1;

        // Exit 0 means valid, exit 1 means validation errors — the CLI's documented contract.
        // Anything else is the harness failing rather than the fixture, and must not be read as a
        // verdict on the skill.
        expect([0, 1]).toContain(exitCode);

        const referenceAcceptsIt = exitCode === 0;

        let packageAcceptsIt = true;
        try {
          parseSkillMarkdown(fixture.skillMarkdown, { directoryName: fixture.directoryName });
        } catch {
          packageAcceptsIt = false;
        }

        if (fixture.knownDivergence) {
          // Asserted as a divergence, so it fails if the disagreement ever closes or changes shape
          // without the corpus being updated to say so.
          expect(referenceAcceptsIt).toBe(fixture.knownDivergence.reference === 'accepts');
          expect(packageAcceptsIt).toBe(fixture.valid);
          expect(packageAcceptsIt).not.toBe(referenceAcceptsIt);
          return;
        }

        expect(referenceAcceptsIt).toBe(fixture.valid);
        expect(packageAcceptsIt).toBe(referenceAcceptsIt);
      });
    }
  },
);
