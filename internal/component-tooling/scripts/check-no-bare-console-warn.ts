/**
 * Development-only-diagnostics guard.
 *
 * Component contract-misuse warnings (a missing required prop, an id that does
 * not match the wrapping FormField, a duplicate key, …) are diagnostics for the
 * developer building the app — never for the end user. They must route through
 * `utilities/dev-warn.ts`'s `devWarn(...)`, which gates on `DEV` from `esm-env`
 * and is dead-code-eliminated from production bundles. A bare `console.warn` in
 * component source ships the warning string (and internal naming) to end users.
 *
 * This script walks `components/cinder/src/components/**` and fails on any
 * `.svelte` or `.ts` file that calls `console.warn` directly. `dev-warn.ts`
 * itself is the single allowed `console.warn` call site.
 *
 * oxlint cannot express this rule: Svelte files are in oxlint's `ignorePatterns`
 * (svelte-check covers them, not oxlint), so a
 * `no-restricted-syntax` rule would never see the component source where the
 * warnings live. A scanned grep with an explicit allow-list is the simplest
 * durable enforcement. Wired into
 * `bun run lint` (and therefore CI).
 */

import { Glob } from 'bun';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cinderComponentRoots } from './discover-component-directories.ts';
import { DEFAULT_FILE_SCAN_CONCURRENCY, mapWithConcurrencyLimit } from './validation-utilities.ts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const componentsRoot = resolve(scriptDirectory, '../../../components/cinder/src/components');

/**
 * Component-relative paths permitted to call `console.warn` directly. Currently
 * empty: `dev-warn.ts` — the one sanctioned `console.warn` seam — lives under
 * `utilities/`, outside the `components/` tree scanned here, so it needs no
 * entry. Add a path here only if a component genuinely needs a raw `console.warn`
 * (none do today), with a comment explaining why.
 */
const ALLOWED_FILES = new Set<string>([]);

/** Matches a `console.warn(` call (with optional whitespace). */
const CONSOLE_WARN_PATTERN = /\bconsole\s*\.\s*warn\s*\(/;

export type BareConsoleWarnViolation = { filePath: string; lineNumber: number; line: string };

/**
 * Every component source file the check reads: under core's components root and each Cinder
 * package's (P-COR-101), less the allowed ones.
 */
export async function consoleWarnScanFiles(
  roots: readonly string[] = cinderComponentRoots(),
): Promise<string[]> {
  const glob = new Glob('**/*.{svelte,ts}');
  const files: string[] = [];
  for (const root of roots) {
    for await (const relativePath of glob.scan({ cwd: root })) {
      if (!ALLOWED_FILES.has(relativePath)) files.push(resolve(root, relativePath));
    }
  }
  return files;
}

export async function scanBareConsoleWarn(): Promise<BareConsoleWarnViolation[]> {
  const absolutePaths = await consoleWarnScanFiles();
  const componentsDirectory = resolve(componentsRoot, '..', '..', '..');

  const violationGroups = await mapWithConcurrencyLimit(
    absolutePaths,
    DEFAULT_FILE_SCAN_CONCURRENCY,
    async (absolutePath): Promise<BareConsoleWarnViolation[]> => {
      const violations: BareConsoleWarnViolation[] = [];
      const source = await Bun.file(absolutePath).text();
      const lines = source.split('\n');
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        if (CONSOLE_WARN_PATTERN.test(line)) {
          violations.push({
            filePath: relative(componentsDirectory, absolutePath),
            lineNumber: index + 1,
            line: line.trim(),
          });
        }
      }
      return violations;
    },
  );

  return violationGroups.flat();
}

async function main(): Promise<void> {
  const violations = await scanBareConsoleWarn();
  if (violations.length === 0) {
    process.stdout.write('check-no-bare-console-warn — OK (component source uses devWarn).\n');
    return;
  }
  process.stderr.write(
    'check-no-bare-console-warn — bare `console.warn` detected in component source.\n' +
      'Developer warnings must route through `devWarn(...)` from `utilities/dev-warn.ts` so they ' +
      'are gated on DEV and stripped from production bundles. Replace `console.warn(...)` with ' +
      '`devWarn(...)`.\n\n',
  );
  for (const violation of violations) {
    process.stderr.write(
      `  ${violation.filePath}:${violation.lineNumber}\n    ${violation.line}\n`,
    );
  }
  process.exit(1);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-no-bare-console-warn failed:', error);
    process.exit(1);
  });
}
