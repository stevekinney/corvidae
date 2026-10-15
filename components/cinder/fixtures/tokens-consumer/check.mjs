/**
 * Consumer proof for the token runtime (COR-486). This file is written the way an application
 * that depends on Cinder would write it: its only import of Cinder is the public
 * `@lostgradient/cinder/tokens/runtime` subpath. It loads a saved Cinder Theme v1 envelope,
 * validates it, evaluates all six contexts, produces the deployment CSS, and checks the result.
 *
 * Run it directly (`bun fixtures/tokens-consumer/check.mjs`) or import `consumerArtifacts()`.
 * The packed-tarball scenario in the issue refers to the published mirror; publication is out
 * of scope here, so this runs against the workspace source subpath, which is the same module.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CINDER_BASE,
  applyCssOnlyOverrides,
  buildThemeSources,
  evaluateThemeProperties,
  renderThemeStylesheet,
  validateThemeSources,
} from '@lostgradient/cinder/tokens/runtime';

const here = dirname(fileURLToPath(import.meta.url));
export const CONTEXTS = [
  'light/default',
  'light/reduced',
  'light/forced-reduced-motion',
  'dark/default',
  'dark/reduced',
  'dark/forced-reduced-motion',
];

/** The saved theme as a builder export writes it: the base embedded, then the user's edits. */
export function savedEnvelopeText() {
  const saved = JSON.parse(readFileSync(join(here, 'theme-overrides.json'), 'utf8'));
  return `${JSON.stringify(
    {
      format: 'com.lostgradient.cinder.theme',
      version: 1,
      id: 'consumer-proof-0001',
      name: saved.name,
      base: {
        packageVersion: CINDER_BASE.packageVersion,
        sourceDigest: CINDER_BASE.sourceDigest,
        resolver: CINDER_BASE.resolver,
        documents: CINDER_BASE.documents,
      },
      overrides: saved.overrides,
      cssOverrides: saved.cssOverrides,
    },
    null,
    2,
  )}\n`;
}

/** Validate a saved envelope (the bundled one by default), evaluate its six contexts, and produce the stylesheet. */
export function consumerArtifacts(envelopeText = savedEnvelopeText()) {
  const envelope = JSON.parse(envelopeText);
  if (envelope.base.sourceDigest !== CINDER_BASE.sourceDigest) {
    throw new Error('The saved envelope was written against a different Cinder base.');
  }
  const sources = buildThemeSources(envelope, 1);
  const diagnostics = validateThemeSources(sources).diagnostics;
  if (diagnostics.length > 0) {
    throw new Error(`The saved envelope is invalid: ${JSON.stringify(diagnostics.slice(0, 3))}`);
  }
  const evaluation = evaluateThemeProperties(sources);
  if (!evaluation.ok) throw new Error('The saved envelope does not evaluate.');
  const maps = Object.fromEntries(
    CONTEXTS.map((context) => [
      context,
      applyCssOnlyOverrides(evaluation.properties[context], envelope.cssOverrides, context),
    ]),
  );
  const css = renderThemeStylesheet(maps, {
    identity: `${envelope.name}, Cinder ${envelope.base.packageVersion} ${envelope.base.sourceDigest}`,
  });
  return { envelope, maps, css, diagnostics };
}

function assert(condition, message) {
  if (!condition) throw new Error(`[tokens-consumer] ${message}`);
}

/** The checks a consumer makes before shipping the stylesheet. Returns the artifacts. */
export function runConsumerChecks() {
  const artifacts = consumerArtifacts();
  const { envelope, maps, css } = artifacts;
  assert(Object.keys(maps).length === 6, 'six contexts are evaluated');
  for (const context of CONTEXTS) {
    assert(Object.keys(maps[context]).length > 300, `${context} has the public property set`);
  }
  assert(maps['light/default']['--cinder-radius-md'] === '5px', 'the shared override applies');
  assert(
    maps['light/default']['--cinder-radius-sm'] === 'var(--cinder-radius-md)',
    'an alias stays an alias',
  );
  assert(maps['dark/default']['--cinder-radius-lg'] === '14px', 'a dark-only override applies');
  assert(maps['light/default']['--cinder-radius-lg'] !== '14px', 'the dark override stays dark');
  assert(
    maps['light/reduced']['--cinder-duration-fast'] === '10ms',
    'the reduced override applies',
  );
  assert(
    maps['dark/default']['--cinder-carousel-slide-size'] === '80%' &&
      maps['light/reduced']['--cinder-carousel-slide-size'] === '90%',
    'CSS-only edits apply to their own context',
  );
  assert(css.includes('@layer cinder-theme {'), 'the stylesheet is in the cinder-theme layer');
  assert(!css.includes('stroke') && !css.includes('brand'), 'Source tokens emit no CSS');
  // COR-245: the inherited strokeStyle source token survives a save and reload untouched.
  const reloaded = JSON.parse(JSON.stringify(envelope));
  assert(
    reloaded.overrides.shared.stroke.$type === 'strokeStyle' &&
      reloaded.overrides.shared.stroke.dashed.$value === 'dashed' &&
      reloaded.overrides.shared.stroke.dotted.$extensions['com.example.editor'].kept === true,
    'the inherited strokeStyle source survives a round trip',
  );
  return artifacts;
}

/** Runs the checks and prints a summary when `entryPath` is this file, i.e. when it was run directly. */
export function runAsScript(entryPath = process.argv[1]) {
  if (entryPath === undefined || fileURLToPath(import.meta.url) !== entryPath) return false;
  const { maps, css } = runConsumerChecks();
  console.log(
    `[tokens-consumer] OK: ${CONTEXTS.length} contexts, ${Object.keys(maps['light/default']).length} properties, ${css.length} bytes of CSS.`,
  );
  return true;
}

runAsScript();
