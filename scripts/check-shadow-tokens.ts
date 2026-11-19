/**
 * Keep shadows light in the light theme and dark in the dark theme.
 *
 * Owner standing order (2026-11-19, "I keep telling you"; COR-2441): light mode is not heavy and
 * dark mode has no bright shadows. A shadow is darkness. It darkens what is under it in both
 * themes; a shadow drawn from text, ink or white glows beneath a panel in dark mode.
 *
 * Two checks, both on text and never on screenshots:
 *
 * - The resolved theme tokens (`components/cinder/src/tokens/resolved/{light,dark}.json`). In each
 *   theme every colour of every token whose name holds `shadow` is black (OKLCH lightness at most
 *   10%). In the light theme no layer is heavier than the agreed alpha in `AGREED_LIGHT_SHADOWS`,
 *   which names every shadow token; a new shadow token needs an agreed ceiling in the same change,
 *   and raising a ceiling is a reviewed edit. This part has no allowlist.
 * - Source. In each CSS, Svelte and TypeScript file under `components`, `applications`, `packages`
 *   and `plugins` (tests excluded), a `box-shadow`, `boxShadow` or `--*shadow*` declaration, or a
 *   `drop-shadow(...)` call, whose value references `--cinder-text-`, `--cinder-ink`,
 *   `--cinder-polarity-ink`, `currentColor`, `white` or `#fff` is reported. Focus-ring tokens are
 *   not elevation shadows and are skipped by name. Offenders from before the guard are listed in
 *   `scripts/shadow-tokens-allowlist.json`, which only shrinks.
 *
 * Runs from the root `lint:guards` script.
 */

import { join } from 'node:path';
import { lineOf, repositoryRoot, runCountGuard, shorten } from './owner-rule-guard-support';

export const SCANNED_DIRECTORIES = ['components', 'applications', 'packages', 'plugins'];
export const ALLOWLIST_PATH = 'scripts/shadow-tokens-allowlist.json';
export const TOKEN_FILES = [
  'components/cinder/src/tokens/resolved/light.json',
  'components/cinder/src/tokens/resolved/dark.json',
];

/** The heaviest alpha any layer of each shadow token has in the light theme. */
export const AGREED_LIGHT_SHADOWS: Readonly<Record<string, number>> = {
  'shadow.small': 0.1,
  'shadow.medium': 0.12,
  'shadow.large': 0.14,
  'shadow.overlay': 0.14,
  'docked-action-bar.shadow-color': 0.08,
  'theme-switch.thumb-shadow-color': 0.25,
};

/** The darkest a shadow's colour can be: OKLCH lightness as a fraction. */
const MAXIMUM_SHADOW_LIGHTNESS = 0.1;

type ShadowColor = { components: readonly number[]; alpha?: number };

function colorsOf(value: unknown): ShadowColor[] {
  if (Array.isArray(value)) return value.flatMap(colorsOf);
  if (typeof value !== 'object' || value === null) return [];
  if ('components' in value) return [value as ShadowColor];
  if ('color' in value) return colorsOf(value.color);
  return [];
}

/** Why a theme's tokens break the rule, one string per problem. */
export function judgeShadowTokens(
  theme: 'light' | 'dark',
  tokens: Readonly<Record<string, { $value?: unknown }>>,
): string[] {
  const problems: string[] = [];
  for (const [name, token] of Object.entries(tokens)) {
    if (!name.includes('shadow')) continue;
    const colors = colorsOf(token.$value);
    if (colors.length === 0) continue;
    for (const color of colors) {
      const lightness = color.components[0] ?? 0;
      if (lightness > MAXIMUM_SHADOW_LIGHTNESS) {
        problems.push(`${theme} ${name} - a shadow colour of lightness ${lightness}, not black`);
      }
    }
    if (theme !== 'light') continue;
    if (!Object.hasOwn(AGREED_LIGHT_SHADOWS, name)) {
      problems.push(
        `light ${name} - a shadow token with no agreed ceiling in AGREED_LIGHT_SHADOWS`,
      );
      continue;
    }
    const ceiling = AGREED_LIGHT_SHADOWS[name]!;
    const heaviest = Math.max(...colors.map((color) => color.alpha ?? 1));
    if (heaviest > ceiling) {
      problems.push(
        `light ${name} - a layer of alpha ${heaviest} is heavier than the agreed ${ceiling}`,
      );
    }
  }
  return problems;
}

const DECLARATION =
  /(?<![\w-])(?:box-shadow|boxShadow|--(?!_cinder-focus-ring)[\w-]*shadow[\w-]*)\s*:\s*([^;}]*)|drop-shadow\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g;
const LIGHT_INK =
  /--cinder-text-|--cinder-(?:polarity-)?ink\b|currentColor|(?<![\w-])white(?![\w-])|#fff(?:fff)?(?![0-9a-f])/i;

/** Every shadow in `source` drawn from text, ink or white, as `<line> - <value>`. */
export function findBrightShadows(source: string): string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  const sites: string[] = [];
  for (const match of text.matchAll(DECLARATION)) {
    const value = (match[1] ?? match[2] ?? '').replace(/var\(\s*--cinder-ring-[^)]*\)/g, ' ');
    if (LIGHT_INK.test(value)) sites.push(`${lineOf(text, match.index)} - ${shorten(value)}`);
  }
  return sites;
}

async function main(): Promise<void> {
  const problems: string[] = [];
  for (const file of TOKEN_FILES) {
    const theme = file.endsWith('light.json') ? 'light' : 'dark';
    const tokens = (await Bun.file(join(repositoryRoot, file)).json()) as Record<
      string,
      { $value?: unknown }
    >;
    problems.push(...judgeShadowTokens(theme, tokens));
  }
  if (problems.length > 0) {
    process.stderr.write(
      'check-shadow-tokens - a shadow token is heavy in light or bright in dark.\n' +
        'Shadows are black in both themes and no heavier in light than AGREED_LIGHT_SHADOWS.\n\n',
    );
    for (const problem of problems) process.stderr.write(`  ${problem}\n`);
    process.exitCode = 1;
  }
  await runCountGuard({
    name: 'check-shadow-tokens',
    advice:
      'a shadow is drawn from text, ink or white.\n' +
      'A shadow is darkness: use --cinder-shadow-* or a black oklch(0% 0 0 / alpha), never a\n' +
      'text, ink or white value, which glows in dark mode.',
    passed: 'shadow tokens are agreed and no new shadow derives from light ink',
    directories: SCANNED_DIRECTORIES,
    extensions: new Set(['.css', '.svelte', '.ts']),
    exclude: /\.(?:test|spec)\.ts$|\.test-harness\.svelte$|\.generated\.ts$/,
    allowlistPath: ALLOWLIST_PATH,
    find: findBrightShadows,
  });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-shadow-tokens failed:', error);
    process.exitCode = 1;
  });
}
