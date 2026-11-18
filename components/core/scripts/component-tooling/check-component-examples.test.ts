/**
 * Tests for the component tooling's examples check. They read Cinder's generated `.metadata`, so
 * they live in Cinder, whose test task waits for its metadata task: the tooling's own test task
 * then reads no component workspace's output, and an example edit does not reach it (COR-2081).
 */

import Ajv from 'ajv/dist/2020.js';
import { describe, expect, it } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExampleArtifact } from '@lostgradient/component-tooling/scripts/check-component-examples.ts';
import {
  checkCommittedExamples,
  validateExampleArtifactValue,
} from '@lostgradient/component-tooling/scripts/check-component-examples.ts';
import type { Manifest } from '@lostgradient/component-tooling/scripts/generate-manifest.ts';
import { readJsonFile } from '@lostgradient/component-tooling/scripts/lib/read-json-file.ts';

/** Cinder's directory: this file is in its `scripts/component-tooling/`. */
const PACKAGE_ROOT = join(import.meta.dir, '..', '..');
const COMPONENT_SCHEMA_PATH = join(
  dirname(
    fileURLToPath(
      import.meta.resolve('@lostgradient/component-tooling/scripts/check-component-examples.ts'),
    ),
  ),
  '..',
  'src',
  'schemas',
  'examples.schema.json',
);
const MANIFEST_PATH = `${PACKAGE_ROOT}/.metadata/components.json`;
/**
 * The sidecar path the checks name in their messages: a label, written once, so the family
 * extraction's rewrite of a path that names a moved file keeps every use the same.
 */
const SIDECAR = '../button/src/components/button/button.examples.json';

const validArtifact = {
  $schema: '../../schemas/examples.schema.json',
  component: 'button',
  import: '@lostgradient/cinder',
  examples: [
    {
      id: 'basic',
      title: 'Basic button',
      description: 'A basic button.',
      code: '<script lang="ts">\n  import { Button } from \'@lostgradient/cinder\';\n</script>',
    },
  ],
};

async function testContext() {
  const schema = await Bun.file(COMPONENT_SCHEMA_PATH).json();
  const manifest = await readJsonFile<Manifest>(MANIFEST_PATH);
  const component = manifest.components.find((entry) => entry.id === 'button');
  if (component === undefined) throw new Error('button manifest entry missing');
  const validator = new Ajv({ allErrors: true, strict: false }).compile<ExampleArtifact>(schema);
  const location = {
    directory: `${PACKAGE_ROOT}/src/components/button`,
    id: 'button',
  } as const;
  return { component, location, validator };
}

describe('committed component examples', () => {
  it('validates every sidecar against the schema and its owning manifest entry', async () => {
    expect(await checkCommittedExamples()).toEqual([]);
  });

  it('rejects a malformed sidecar schema shape', async () => {
    const { component, location, validator } = await testContext();
    const malformed = { ...validArtifact, examples: [] };
    const issues = validateExampleArtifactValue(
      malformed,
      location,
      'button',
      SIDECAR,
      validator,
      component,
    );
    expect(issues.some((issue) => issue.includes('schema validation failed'))).toBe(true);
  });

  it('rejects a sidecar whose component does not belong to its directory', async () => {
    const { component, location, validator } = await testContext();
    const issues = validateExampleArtifactValue(
      { ...validArtifact, component: 'card' },
      location,
      'button',
      SIDECAR,
      validator,
      component,
    );
    expect(issues).toContain(
      `${SIDECAR}: component "card" does not match owning directory "button"`,
    );
  });

  it('rejects a sidecar whose manifest relationship is stale', async () => {
    const { component, location, validator } = await testContext();
    const issues = validateExampleArtifactValue(
      validArtifact,
      location,
      'button',
      SIDECAR,
      validator,
      {
        ...component,
        hasExamples: false,
        artifacts: { ...component.artifacts, examples: 'wrong.json' },
      },
    );
    expect(issues).toContain(
      `${SIDECAR}: components.json does not advertise this examples artifact`,
    );
    expect(issues).toContain(`${SIDECAR}: manifest artifact path is "wrong.json"`);
  });

  it('rejects metadata and code imports outside the public root', async () => {
    const { component, location, validator } = await testContext();
    const issues = validateExampleArtifactValue(
      {
        ...validArtifact,
        import: '@lostgradient/cinder/button',
        examples: [
          {
            ...validArtifact.examples[0],
            code: "import { Button } from '@lostgradient/cinder/button';",
          },
        ],
      },
      location,
      'button',
      SIDECAR,
      validator,
      component,
    );
    expect(issues).toContain(`${SIDECAR}: import must use public root "@lostgradient/cinder"`);
    expect(issues).toContain(
      `${SIDECAR}: example code must use the public root import "@lostgradient/cinder"`,
    );
  });
});
