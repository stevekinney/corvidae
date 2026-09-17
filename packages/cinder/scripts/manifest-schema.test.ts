/**
 * Tests for the manifest generator.
 *
 * Uses a synthetic 3-component metadata array (no real extractor) so these
 * tests pass even before the full annotation sweep completes.
 *
 * The primary gate: a manifest produced from valid metadata validates against
 * `manifest.schema.json`.
 */

import { join } from 'node:path';

import Ajv from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, it } from 'bun:test';

// ---------------------------------------------------------------------------
// Schema loader helper
// ---------------------------------------------------------------------------

import { SYNTHETIC_COMPONENTS, buildSyntheticManifest } from './manifest.test-support.ts';
const SCHEMA_PATH = join(import.meta.dir, '..', 'src', 'schemas', 'manifest.schema.json');

async function loadManifestSchema(): Promise<object> {
  const text = await Bun.file(SCHEMA_PATH).text();
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null) throw new Error('Expected schema object');
  return value;
}

// ---------------------------------------------------------------------------
// Synthetic test data
// ---------------------------------------------------------------------------

describe('manifest schema', () => {
  let ajv: Ajv;
  let validateManifest: ReturnType<Ajv['compile']>;

  beforeAll(async () => {
    const schema = await loadManifestSchema();
    ajv = new Ajv({ strict: false });
    validateManifest = ajv.compile(schema);
  });

  it('the manifest schema itself is valid JSON', async () => {
    const schema = await loadManifestSchema();
    expect(schema).toBeObject();
    expect(Reflect.get(schema, '$schema')).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('a correctly-shaped synthetic manifest validates without errors', () => {
    const manifest = buildSyntheticManifest();
    const valid = validateManifest(manifest);
    expect(valid).toBe(true);
    expect(validateManifest.errors).toBeNull();
  });

  it('manifestVersion must equal 1', () => {
    const manifest = buildSyntheticManifest();
    // @ts-expect-error — intentionally wrong value for negative test
    manifest.manifestVersion = 2;
    const valid = validateManifest(manifest);
    expect(valid).toBe(false);
  });

  it('framework must equal "svelte"', () => {
    const manifest = buildSyntheticManifest();
    // @ts-expect-error — intentionally wrong value for negative test
    manifest.package.framework = 'react';
    const valid = validateManifest(manifest);
    expect(valid).toBe(false);
  });

  it('rejects a component id that contains uppercase letters', () => {
    const manifest = buildSyntheticManifest();
    // Deep clone to avoid mutating shared fixture
    manifest.components = [
      {
        ...SYNTHETIC_COMPONENTS[0]!,
        id: 'ButtonGroup', // PascalCase — must be rejected
      },
    ];
    const valid = validateManifest(manifest);
    expect(valid).toBe(false);
  });

  it('rejects a purpose string that exceeds 200 characters', () => {
    const manifest = buildSyntheticManifest();
    manifest.components = [
      {
        ...SYNTHETIC_COMPONENTS[0]!,
        purpose: 'A'.repeat(201),
      },
    ];
    const valid = validateManifest(manifest);
    expect(valid).toBe(false);
  });

  it('accepts an avoidWhen entry with a kebab alternative and one without', () => {
    const manifest = buildSyntheticManifest();
    manifest.components = [
      {
        ...SYNTHETIC_COMPONENTS[0]!,
        avoidWhen: [
          { reason: 'Reason with alt.', alternative: 'segmented-control' },
          { reason: 'Reason without alt.' },
        ],
      },
    ];
    const valid = validateManifest(manifest);
    expect(valid).toBe(true);
  });

  it('rejects an avoidWhen entry missing the required "reason" field', () => {
    const manifest = buildSyntheticManifest();
    manifest.components = [
      {
        ...SYNTHETIC_COMPONENTS[0]!,
        // @ts-expect-error — intentionally missing required reason
        avoidWhen: [{ alternative: 'toggle' }],
      },
    ];
    const valid = validateManifest(manifest);
    expect(valid).toBe(false);
  });

  it('rejects an avoidWhen alternative that is not kebab-case', () => {
    const manifest = buildSyntheticManifest();
    manifest.components = [
      {
        ...SYNTHETIC_COMPONENTS[0]!,
        avoidWhen: [{ reason: 'A reason.', alternative: 'SegmentedControl' }],
      },
    ];
    const valid = validateManifest(manifest);
    expect(valid).toBe(false);
  });

  it('accepts a component with no a11y block (a11y is optional)', () => {
    const manifest = buildSyntheticManifest();
    const jsonViewer = manifest.components.find((c) => c.id === 'json-viewer');
    expect(jsonViewer?.a11y).toBeUndefined();
    const valid = validateManifest(manifest);
    expect(valid).toBe(true);
  });

  it('rejects an a11y keyboard entry missing the required "action" field', () => {
    const manifest = buildSyntheticManifest();
    manifest.components = [
      {
        ...SYNTHETIC_COMPONENTS[0]!,
        // @ts-expect-error — intentionally missing required action
        a11y: { keyboard: [{ keys: 'Enter' }] },
      },
    ];
    const valid = validateManifest(manifest);
    expect(valid).toBe(false);
  });

  it('rejects an empty a11y notes array (minItems aligns the schema with the runtime guard)', () => {
    // The runtime guard `isA11yMetadata` rejects `notes: []`, and the generator
    // only emits `notes` when non-empty; the schema must agree so a schema-valid
    // payload can never be rejected at runtime.
    const manifest = buildSyntheticManifest();
    manifest.components = [
      {
        ...SYNTHETIC_COMPONENTS[0]!,
        a11y: { notes: [] },
      },
    ];
    const valid = validateManifest(manifest);
    expect(valid).toBe(false);
  });

  it('rejects a component entry missing the required "id" field', () => {
    const manifest = buildSyntheticManifest();
    const { id: _id, ...withoutId } = SYNTHETIC_COMPONENTS[0]!;
    // @ts-expect-error — intentionally missing required field
    manifest.components = [withoutId];
    const valid = validateManifest(manifest);
    expect(valid).toBe(false);
  });

  it('accepts a component with hasExamples=true and an examples artifact', () => {
    const manifest = buildSyntheticManifest();
    // modal in the synthetic set has hasExamples=true and an examples artifact
    const modal = manifest.components.find((c) => c.id === 'modal');
    expect(modal?.hasExamples).toBe(true);
    expect(modal?.artifacts.examples).toBe('src/components/modal/modal.examples.json');
    const valid = validateManifest(manifest);
    expect(valid).toBe(true);
  });

  it('accepts a component with hasConstraints=true and a constraints artifact', () => {
    const manifest = buildSyntheticManifest();
    const modal = manifest.components.find((c) => c.id === 'modal');
    expect(modal?.hasConstraints).toBe(true);
    expect(modal?.artifacts.constraints).toBe('src/components/modal/modal.constraints.json');
    const valid = validateManifest(manifest);
    expect(valid).toBe(true);
  });

  it('rejects a manifest missing the "components" array', () => {
    const manifest = buildSyntheticManifest();
    // @ts-expect-error — intentionally missing required field
    delete manifest.components;
    const valid = validateManifest(manifest);
    expect(valid).toBe(false);
  });

  it('rejects a manifest missing the "package" object', () => {
    const manifest = buildSyntheticManifest();
    // @ts-expect-error — intentionally missing required field
    delete manifest.package;
    const valid = validateManifest(manifest);
    expect(valid).toBe(false);
  });

  it('rejects unexpected top-level properties (additionalProperties: false)', () => {
    const manifest = buildSyntheticManifest();
    (manifest as Record<string, unknown>)['unexpectedField'] = 'not allowed';
    const valid = validateManifest(manifest);
    expect(valid).toBe(false);
  });
});
