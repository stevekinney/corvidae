/**
 * Regression test for `04-schema-hygiene-a`: fifteen components declared
 * their props as a bare intersection with an HTML attribute type
 * (`HTMLAttributes<...> & { class?: string }`) instead of the house
 * `Omit<Base, 'class'> & { class?: string }` pattern, so the schema
 * generator saw `class` as `ClassValue & string`, couldn't reduce it, and
 * emitted it under `metadata.unsupportedProps` with `reason: 'unknown-shape'`.
 *
 * This test reads every component's generated schema from `.metadata/` (the
 * `metadata` task writes it; see the component tooling's `scripts/lib/metadata-files.ts`) and
 * asserts none of them list `class` under `unsupportedProps`. It lives in Cinder, whose test task
 * waits for that metadata task, so the tooling's own test task reads no component workspace's
 * output (COR-2081).
 */

import { describe, expect, test } from 'bun:test';

import { discoverComponentDirectories } from '@lostgradient/component-tooling/scripts/discover-component-directories.ts';
import { readComponentSchema } from '@lostgradient/component-tooling/scripts/lib/metadata-files.ts';

describe('generated component schemas — class prop narrowing', () => {
  test('no schema lists `class` under unsupportedProps', async () => {
    const components = await discoverComponentDirectories();
    expect(components.length).toBeGreaterThan(100);

    const offenders = components
      .filter(({ name }) =>
        (readComponentSchema(name).metadata?.unsupportedProps ?? []).some(
          (prop) => prop.name === 'class',
        ),
      )
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });
});
