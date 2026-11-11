import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyCheckScripts,
  findGateInvocations,
  findReportOnlyInvocations,
  findUninvokedChecks,
} from './gate-wiring.ts';

const PACKAGE_ROOT = join(import.meta.dirname, '..');
const SCRIPTS_DIRECTORY = import.meta.dirname;

function readPackageScripts(): Record<string, string> {
  const manifest: unknown = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  if (typeof manifest !== 'object' || manifest === null || !('scripts' in manifest)) {
    throw new Error('components/cinder/package.json has no scripts.');
  }
  return manifest.scripts as Record<string, string>;
}

const ENTRY_POINT = 'export function run() {}\nif (import.meta.main) run();\n';
const LIBRARY = 'export function helper() {}\n';

/** Builds a throwaway scripts directory from `file name -> source`, and removes it afterwards. */
function withScriptsDirectory(
  files: Record<string, string>,
  assert: (scriptsDirectory: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), 'gate-wiring-'));
  const scriptsDirectory = join(root, 'scripts');
  mkdirSync(scriptsDirectory);
  try {
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(scriptsDirectory, name), source);
    }
    assert(scriptsDirectory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Cinder's own gates", () => {
  // The list is spelled out, flags included, so dropping a check or its `--strict` from `lint`
  // fails here. `--strict` is what makes two of them gates: without it they only report.
  test('lint runs every check, with the flags that make it a gate', () => {
    expect(findGateInvocations(readPackageScripts(), ['lint'])).toEqual([
      'scripts/check-prop-conventions.ts src/components ../chat/src/lib/components ../editor/src/lib/components',
      'scripts/check-test-cleanup.ts',
      'scripts/check-aggregator-completeness.ts',
      'scripts/check-component-css-raw-colors.ts --strict',
      'scripts/check-component-examples.ts',
      'scripts/check-component-inventory.ts',
      'scripts/check-component-variable-registry.ts',
      'scripts/check-css-duplication.ts',
      'scripts/check-data-cinder-boolean-attributes.ts',
      'scripts/check-design-token-literals.ts --strict',
      'scripts/check-no-bare-console-warn.ts',
      'scripts/check-no-inline-match-media.ts',
      'scripts/check-no-static-style-attributes.ts',
      'scripts/check-placeholder-docs.ts',
      'scripts/check-platform-features.ts --strict',
      'scripts/check-prose-component-references.ts',
      'scripts/check-readme-usage.ts',
      'scripts/check-svelte-ts-runtime-types.ts',
      'scripts/check-token-naming.ts',
      'scripts/check-token-registry-privacy.ts',
      'scripts/check-virtual-list-dependency-free.ts',
      'scripts/tokens/validate-corpus.ts',
      'scripts/tokens/generate-artifacts.ts --check',
      'scripts/check-component-css-token-usage.ts --strict',
      '../../scripts/check-inherited-key-reads.ts',
    ]);
  });

  test('every check command is run by a gate', () => {
    expect(findUninvokedChecks(SCRIPTS_DIRECTORY, readPackageScripts())).toEqual([]);
  });

  test('no gate runs a check in its report-only mode', () => {
    expect(findReportOnlyInvocations(SCRIPTS_DIRECTORY, readPackageScripts())).toEqual([]);
  });

  test('no check runs on import without an entry-point guard', () => {
    const { entryPoints, unguarded } = classifyCheckScripts(SCRIPTS_DIRECTORY);

    expect(unguarded).toEqual([]);
    expect(entryPoints.length).toBeGreaterThanOrEqual(22);
  });
});

describe('findUninvokedChecks', () => {
  test('reports a check command no gate runs, and no library module', () => {
    withScriptsDirectory(
      {
        'check-wired.ts': ENTRY_POINT,
        'check-orphan.ts': ENTRY_POINT,
        'check-orphan.test.ts': ENTRY_POINT,
        'check-shared-parser.ts': LIBRARY,
        'generate-artifacts.ts': ENTRY_POINT,
      },
      (scriptsDirectory) => {
        expect(
          findUninvokedChecks(scriptsDirectory, { lint: 'bun scripts/check-wired.ts' }),
        ).toEqual(['check-orphan.ts']);
      },
    );
  });

  test('accepts a check a gate reaches through another script', () => {
    withScriptsDirectory({ 'check-wired.ts': ENTRY_POINT }, (scriptsDirectory) => {
      const scripts = {
        lint: 'oxlint src && bun run lint:checks',
        'lint:checks': 'bun run check:wired',
        'check:wired': 'bun scripts/check-wired.ts --strict',
      };

      expect(findUninvokedChecks(scriptsDirectory, scripts)).toEqual([]);
    });
  });

  test.each(['test', 'test:coverage', 'typecheck'])('accepts a check run by %s', (gate) => {
    withScriptsDirectory({ 'check-wired.ts': ENTRY_POINT }, (scriptsDirectory) => {
      expect(
        findUninvokedChecks(scriptsDirectory, { [gate]: 'TZ=UTC bun scripts/check-wired.ts' }),
      ).toEqual([]);
    });
  });

  test('does not count a script no gate runs', () => {
    withScriptsDirectory({ 'check-wired.ts': ENTRY_POINT }, (scriptsDirectory) => {
      const scripts = {
        lint: 'oxlint src',
        'release:check': 'bun scripts/check-wired.ts',
        'check:wired': 'bun scripts/check-wired.ts',
      };

      expect(findUninvokedChecks(scriptsDirectory, scripts)).toEqual(['check-wired.ts']);
    });
  });
});

describe('findReportOnlyInvocations', () => {
  const REPORTING_CHECK =
    "if (import.meta.main) process.exitCode = process.argv.includes('--strict') ? 1 : 0;\n";

  // The gap the first review of COR-2075 found: two checks were wired in the mode that prints a
  // report and exits 0, so `lint` ran them and could not fail on them.
  test('reports a check with a strict mode that a gate runs without it', () => {
    withScriptsDirectory(
      { 'check-report.ts': REPORTING_CHECK, 'check-plain.ts': ENTRY_POINT },
      (scriptsDirectory) => {
        const scripts = {
          lint: 'bun scripts/check-report.ts && bun scripts/check-plain.ts',
          test: 'bun ../../scripts/bun-test.ts src',
        };

        expect(findReportOnlyInvocations(scriptsDirectory, scripts)).toEqual([
          'scripts/check-report.ts',
        ]);
      },
    );
  });

  test('accepts the same check run with --strict, and a report no gate runs', () => {
    withScriptsDirectory({ 'check-report.ts': REPORTING_CHECK }, (scriptsDirectory) => {
      const scripts = {
        lint: 'bun scripts/check-report.ts --strict',
        audit: 'bun scripts/check-report.ts',
      };

      expect(findReportOnlyInvocations(scriptsDirectory, scripts)).toEqual([]);
    });
  });
});

describe('findGateInvocations', () => {
  test('keeps arguments, drops environment words, and follows a script once', () => {
    const scripts = {
      lint: 'oxlint src && bun run checks && bun run checks && bun ../../scripts/shared.ts',
      checks: 'A=1 B=2 bun scripts/check-one.ts --strict  src && bun run lint',
      test: 'bun test src',
    };

    expect(findGateInvocations(scripts)).toEqual([
      'scripts/check-one.ts --strict src',
      '../../scripts/shared.ts',
    ]);
  });
});

describe('classifyCheckScripts', () => {
  // The gap COR-2075 found: `check-svelte-ts-runtime-types.ts` ended in a bare `await main();`,
  // so a rule keyed on `import.meta.main` alone would have exempted a real command as a library.
  test('reports a check that runs on import without the guard', () => {
    withScriptsDirectory(
      {
        'check-guarded.ts': ENTRY_POINT,
        'check-library.ts': LIBRARY,
        'check-unguarded.ts': 'async function main() {}\nawait main();\n',
      },
      (scriptsDirectory) => {
        expect(classifyCheckScripts(scriptsDirectory)).toEqual({
          entryPoints: ['check-guarded.ts'],
          unguarded: ['check-unguarded.ts'],
        });
      },
    );
  });

  // A script does not have to end in a bare call to run on import.
  test.each([
    ['a try block', 'function main() {}\ntry {\n  main();\n} catch {\n  process.exit(1);\n}\n'],
    ['a condition', "function main() {}\nif (process.argv.includes('--run')) main();\n"],
    ['a loop', 'function main() {}\nfor (const name of process.argv) main();\n'],
  ])('reports a check that runs on import through %s', (_shape, source) => {
    withScriptsDirectory({ 'check-unguarded.ts': source }, (scriptsDirectory) => {
      expect(classifyCheckScripts(scriptsDirectory).unguarded).toEqual(['check-unguarded.ts']);
    });
  });

  test('treats a module of declarations as a library', () => {
    const source = [
      "import { join } from 'node:path';",
      "export const ROOT = join('a', 'b');",
      'export type Shape = { name: string };',
      'export interface Named { name: string }',
      'export enum Mode { Report, Strict }',
      'export class Scanner {}',
      'export function scan(): void {}',
      "export { join as joinPath } from 'node:path';",
      'export default scan;',
      '',
    ].join('\n');

    withScriptsDirectory({ 'check-library.ts': source }, (scriptsDirectory) => {
      expect(classifyCheckScripts(scriptsDirectory)).toEqual({ entryPoints: [], unguarded: [] });
    });
  });
});
