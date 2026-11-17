/**
 * Prefers-reduced-motion policy guard.
 *
 * OVERLAY-POLICY (§ Reduced motion) mandates the shared `useReducedMotion()` hook
 * from `utilities/use-reduced-motion.svelte.ts` for all client-side reduced-motion
 * checks. Inline `window.matchMedia('(prefers-reduced-motion…')` calls:
 *   - Are not reactive — a user changing the OS preference mid-session is ignored.
 *   - Duplicate the SSR-guard logic that `useReducedMotion` already handles.
 *   - Scatter the policy across components, making future changes error-prone.
 *
 * This script walks `components/core/src/{components,utilities,_internal}/**`
 * and flags any `.svelte` or `.ts` file that contains BOTH a `matchMedia` call and a
 * `prefers-reduced-motion` string — the two-signal approach (see below) — so the guard
 * cannot be evaded by hoisting the query into a constant. The shared utility itself is
 * the single allowed call site.
 *
 * The check is whole-file (not line-based) so it survives Prettier reformatting that
 * splits a call across lines, and reports a file-level flag rather than a line number.
 *
 * Like `check-no-bare-console-warn.ts`, oxlint cannot express this rule for Svelte
 * files (they are in its ignorePatterns). Wired into `bun run lint` (and therefore
 * CI) via `package.json`.
 */

import { Glob } from 'bun';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cinderSourceRoots } from './discover-component-directories.ts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(scriptDirectory, '../../../components/core/src');

/**
 * Paths (relative to `src/`) permitted to call `matchMedia` with the
 * reduced-motion query directly. The shared utility is the single allowed site.
 */
const ALLOWED_RELATIVE_PATHS = new Set<string>(['utilities/use-reduced-motion.svelte.ts']);

/**
 * A file is flagged when it contains BOTH signals — a `matchMedia` call AND a
 * `prefers-reduced-motion` string anywhere in the file. Matching the two
 * independently (rather than requiring the media string inside the call's argument
 * list) catches the indirect form where the query is hoisted to a constant:
 *
 *   const QUERY = '(prefers-reduced-motion: reduce)';
 *   window.matchMedia(QUERY);
 *
 * Both patterns ignore whitespace/newlines, so Prettier-formatted code is covered.
 * The two-signal approach can in principle co-flag a file that legitimately uses
 * `matchMedia` for an unrelated query AND mentions `prefers-reduced-motion` only in
 * a comment — but in this package the only reason to write the reduced-motion string
 * is to query it, so the precision is acceptable and errs toward catching evasions.
 */
const MATCH_MEDIA_CALL_PATTERN = /matchMedia\s*\??\.?\s*\(/;
const REDUCED_MOTION_STRING_PATTERN = /prefers-reduced-motion/;

type Violation = { filePath: string };

/**
 * Every file the check reads, with its path relative to its package's `src`: the `components`,
 * `utilities` and `_internal` trees of core and each Cinder package (P-COR-101).
 */
export async function matchMediaScanFiles(
  sourceRoots: readonly string[] = cinderSourceRoots(),
): Promise<{ absolutePath: string; sourceRelative: string }[]> {
  const glob = new Glob('**/*.{svelte,ts}');
  const files: { absolutePath: string; sourceRelative: string }[] = [];
  for (const sourceRoot of sourceRoots) {
    for (const subdir of ['components', 'utilities', '_internal']) {
      const root = resolve(sourceRoot, subdir);
      if (!existsSync(root)) continue;
      for await (const relativePath of glob.scan({ cwd: root })) {
        files.push({
          absolutePath: resolve(root, relativePath),
          sourceRelative: `${subdir}/${relativePath}`,
        });
      }
    }
  }
  return files;
}

async function scan(): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const { absolutePath, sourceRelative } of await matchMediaScanFiles()) {
    if (ALLOWED_RELATIVE_PATHS.has(sourceRelative)) continue;
    const source = await Bun.file(absolutePath).text();
    if (MATCH_MEDIA_CALL_PATTERN.test(source) && REDUCED_MOTION_STRING_PATTERN.test(source)) {
      violations.push({ filePath: relative(resolve(srcRoot, '..', '..', '..'), absolutePath) });
    }
  }
  return violations;
}

async function main(): Promise<void> {
  const violations = await scan();
  if (violations.length === 0) {
    process.stdout.write(
      'check-no-inline-match-media — OK (reduced-motion checks use the shared useReducedMotion() hook).\n',
    );
    return;
  }

  process.stderr.write(
    'check-no-inline-match-media — inline matchMedia(prefers-reduced-motion…) detected.\n' +
      'Use `useReducedMotion()` from `utilities/use-reduced-motion.svelte.ts` instead of\n' +
      'calling matchMedia directly. The hook is reactive, SSR-safe, and the single canonical\n' +
      'source for this preference per OVERLAY-POLICY.md § Reduced motion.\n\n',
  );
  for (const violation of violations) {
    process.stderr.write(`  ${violation.filePath}\n`);
  }
  process.exit(1);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-no-inline-match-media failed:', error);
    process.exit(1);
  });
}
