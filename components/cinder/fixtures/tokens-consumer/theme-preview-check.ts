/**
 * Computed-style parity between the builder preview and a clean consumer page (COR-486).
 *
 * Two pages load the same Cinder token stylesheet. The reference page applies each context's
 * evaluated property map inline, exactly as the builder's preview frame does. The consumer
 * page applies nothing inline: it has only the exported theme stylesheet. For all six contexts
 * the check compares every public property on the root, an inheriting descendant, a nested
 * scope of the other theme, and a portal container attached to the body, plus the geometry of
 * a probe that uses tokens.
 *
 * Tolerance: exact equality after whitespace normalization, numeric parts within 1e-6, and
 * measured geometry within 1 CSS pixel.
 */

import { chromium, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTEXTS, runConsumerChecks } from './check.mjs';
import { equalWithinTolerance, GEOMETRY_TOLERANCE } from './tolerance.ts';

const here = dirname(fileURLToPath(import.meta.url));
type Maps = Record<string, Record<string, string>>;
type Scope = 'root' | 'descendant' | 'nested' | 'portal';
type Measurement = { values: Record<string, string>; width: number; radius: number };
type Measured = Record<Scope, Measurement>;

function pageHtml(withTheme: boolean): string {
  const html = readFileSync(join(here, 'theme-preview.html'), 'utf8');
  return html.replace('<!--THEME-->', withTheme ? '<link rel="stylesheet" href="/theme.css">' : '');
}

/** Runs in the page: put the page in a context, then read every scope. */
async function measure(page: Page, context: string, inline: Maps | null): Promise<Measured> {
  const [theme, motion] = context.split('/') as [string, string];
  const other = theme === 'light' ? 'dark' : 'light';
  await page.emulateMedia({ reducedMotion: motion === 'reduced' ? 'reduce' : 'no-preference' });
  return page.evaluate(
    ({ theme, other, motion, context, inline, names }) => {
      const root = document.documentElement;
      root.setAttribute('data-theme', theme);
      if (motion === 'forced-reduced-motion') root.setAttribute('data-reduced-motion', 'on');
      else root.removeAttribute('data-reduced-motion');
      document.getElementById('nested')?.setAttribute('data-theme', other);
      document.querySelector('#portal')?.remove();
      const portal = document.createElement('div');
      portal.id = 'portal';
      portal.setAttribute('data-theme', other);
      document.body.append(portal);
      const targets: Record<string, HTMLElement> = {
        root,
        descendant: document.getElementById('descendant')!,
        nested: document.getElementById('nested')!,
        portal,
      };
      const apply = (element: HTMLElement, map: Record<string, string> | undefined) => {
        element.removeAttribute('style');
        if (map === undefined) return;
        for (const [name, value] of Object.entries(map)) element.style.setProperty(name, value);
      };
      if (inline !== null) {
        apply(root, inline[context]);
        apply(targets['descendant']!, undefined);
        apply(targets['nested']!, inline[`${other}/${motion}`]);
        apply(portal, inline[`${other}/${motion}`]);
      }
      const read = (element: HTMLElement) => {
        const probe = document.createElement('div');
        probe.style.cssText =
          'box-sizing:content-box;width:calc(var(--cinder-space-4) * 10);padding-inline:var(--cinder-space-2);border-radius:var(--cinder-radius-md);';
        element.append(probe);
        const style = getComputedStyle(element);
        const values: Record<string, string> = {};
        for (const name of names) values[name] = style.getPropertyValue(name).trim();
        const box = probe.getBoundingClientRect();
        const radius = Number.parseFloat(getComputedStyle(probe).borderTopLeftRadius);
        probe.remove();
        return { values, width: box.width, radius };
      };
      return Object.fromEntries(
        Object.entries(targets).map(([scope, element]) => [scope, read(element)]),
      ) as Record<string, { values: Record<string, string>; width: number; radius: number }>;
    },
    { theme, other, motion, context, inline, names: Object.keys(inline?.[context] ?? ALL_NAMES) },
  ) as Promise<Measured>;
}

let ALL_NAMES: Record<string, string> = {};

export type ParityResult = { checked: number; mismatches: string[] };

export async function checkPreviewParity(): Promise<ParityResult> {
  const { maps, css } = runConsumerChecks();
  ALL_NAMES = maps['light/default']!;
  const tokensCss = readFileSync(join(here, '../../src/styles/tokens-base.css'), 'utf8');
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const { pathname, searchParams } = new URL(request.url);
      if (pathname === '/tokens.css')
        return new Response(tokensCss, { headers: { 'content-type': 'text/css' } });
      if (pathname === '/theme.css')
        return new Response(css, { headers: { 'content-type': 'text/css' } });
      if (pathname === '/') {
        return new Response(pageHtml(searchParams.get('reference') === null), {
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  const browser = await chromium.launch();
  const mismatches: string[] = [];
  let checked = 0;
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const consumer = await browser.newPage();
    const reference = await browser.newPage();
    const problems: string[] = [];
    for (const page of [consumer, reference]) {
      page.on('console', (message) => {
        if (['error', 'warning'].includes(message.type())) problems.push(message.text());
      });
      page.on('pageerror', (error) => problems.push(error.message));
    }
    await consumer.goto(`${origin}/`);
    await reference.goto(`${origin}/?reference`);
    for (const context of CONTEXTS) {
      const expected = await measure(reference, context, maps);
      const actual = await measure(consumer, context, null);
      for (const scope of Object.keys(expected) as Scope[]) {
        for (const [name, want] of Object.entries(expected[scope].values)) {
          checked += 1;
          const got = actual[scope].values[name] ?? '';
          if (!equalWithinTolerance(got, want)) {
            mismatches.push(`${context} ${scope} ${name}: got "${got}", want "${want}"`);
          }
        }
        checked += 2;
        if (Math.abs(actual[scope].width - expected[scope].width) > GEOMETRY_TOLERANCE) {
          mismatches.push(
            `${context} ${scope} probe width ${actual[scope].width} vs ${expected[scope].width}`,
          );
        }
        if (Math.abs(actual[scope].radius - expected[scope].radius) > GEOMETRY_TOLERANCE) {
          mismatches.push(
            `${context} ${scope} probe radius ${actual[scope].radius} vs ${expected[scope].radius}`,
          );
        }
      }
    }
    mismatches.push(...problems.map((problem) => `console: ${problem}`));
  } finally {
    await browser.close();
    await server.stop(true);
  }
  return { checked, mismatches };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { checked, mismatches } = await checkPreviewParity();
  if (mismatches.length > 0) {
    console.error(`[tokens-consumer] ${mismatches.length} of ${checked} computed values differ:`);
    for (const line of mismatches.slice(0, 25)) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(
    `[tokens-consumer] OK: ${checked} computed values match across 6 contexts and 4 scopes.`,
  );
}
