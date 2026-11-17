/**
 * Playground-side tests for the example-harness strip (#399). The transform
 * itself lives in `strip-example-harness.ts`, and its fixture/unit suite is
 * `strip-example-harness-transform.test.ts`. This file covers the two things
 * that need the playground's own surroundings:
 *
 *   1. Route integration: {@link exampleSnippetResponse} turns a successful strip
 *      into a 200 and a fail-closed throw into a controlled 500.
 *   2. A parametrized sweep over EVERY real example file that contains the
 *      harness: strip it, assert no harness symbol survives, and compile the
 *      stripped output with `svelte/compiler` to prove it is still valid,
 *      copy-pasteable Svelte (catches any dangling derived-id reference a narrower
 *      string assertion would miss). Its count is cross-checked against the
 *      featured-example registry so a moved/renamed dir can't silently zero the
 *      sweep. A new harness shape that the fail-closed parser can't handle must
 *      break this corpus sweep rather than ship, so it must stay green.
 */

import { describe, expect, it } from 'bun:test';

import { compile } from 'svelte/compiler';

import { discoverExampleFiles } from './discover.ts';
import { FEATURED_EXAMPLES } from './featured-examples.ts';
import { exampleSnippetResponse } from './playground-server.ts';
import { stripExampleHarness } from './strip-example-harness.ts';

describe('exampleSnippetResponse — route glue', () => {
  it('returns a 200 text/plain stripped snippet on success', async () => {
    const source = `<script lang="ts">
  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let fieldId = $derived(\`\${mountIdPrefix ?? uid}-field\`);
</script>

<Input id={fieldId} />
`;
    const response = exampleSnippetResponse(source, 'input/basic');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain');
    const body = await response.text();
    expect(body).toContain('<Input id="field" />');
    expect(body).not.toContain('mountIdPrefix');
    expect(body).not.toContain('$props.id()');
  });

  it('returns a controlled 500 (not a crash) when the strip fails closed', async () => {
    // `data-foo={fieldId}` leaves the identifier dangling → strip throws → the
    // route must answer with a diagnostic 500, never an opaque connection error.
    const source = `<script lang="ts">
  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let fieldId = $derived(\`\${mountIdPrefix ?? uid}-field\`);
</script>

<Input data-foo={fieldId} />
`;
    const response = exampleSnippetResponse(source, 'broken/example');
    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Type')).toBe('text/plain');
    const body = await response.text();
    expect(body).toContain('broken/example');
    expect(body).toContain('Failed to prepare example snippet');
  });
});

describe('stripExampleHarness — every harnessed example stays valid Svelte', () => {
  it('strips and compiles all real example files cleanly', async () => {
    const examples = await discoverExampleFiles();
    expect(examples.length).toBeGreaterThan(0);

    const harnessed: string[] = [];
    for (const { component: componentName, scenario, filePath: file } of examples) {
      const source = await Bun.file(file).text();
      if (!source.includes('mountIdPrefix')) continue;

      harnessed.push(`${componentName}/${scenario}`);

      const stripped = stripExampleHarness(source, `${componentName}/${scenario}`);

      // No harness plumbing may leak into the reader snippet.
      expect(stripped).not.toContain('mountIdPrefix');
      expect(stripped).not.toContain('$props.id()');

      // The stripped snippet must still be valid, copy-pasteable Svelte —
      // catches any dangling derived-id reference left by an unhandled binding.
      expect(() =>
        compile(stripped, { filename: file, generate: 'client', dev: false }),
      ).not.toThrow();
    }

    // Every featured example carries the harness, so the sweep must find at
    // least that many. Cross-checking against the registry (rather than a bare
    // magic number) means a moved/renamed example dir fails here loudly instead
    // of silently matching zero harnessed files.
    expect(harnessed.length).toBeGreaterThanOrEqual(FEATURED_EXAMPLES.length);
  });
});
