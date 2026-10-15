import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

/**
 * The hosting configuration sends `frame-ancestors 'none'` on every route, which also blocks
 * the theme builder's SAME-ORIGIN preview iframe. The preview route must be framed by its own
 * origin and nothing else, and no other route may lose the `'none'`. Vercel header precedence
 * for two rules that match one path cannot be exercised locally, so the general rule must not
 * match the preview path at all.
 */
type HeaderRule = { source: string; headers: { key: string; value: string }[] };

async function headerRules(): Promise<HeaderRule[]> {
  const configuration = (await Bun.file(join(import.meta.dirname, '..', 'vercel.json')).json()) as {
    headers: HeaderRule[];
  };
  return configuration.headers;
}

/** The subset of Vercel's path-to-regexp sources this file uses: literal paths and `(…)` groups. */
function matches(source: string, path: string): boolean {
  return new RegExp(`^${source}$`).test(path);
}

function frameAncestors(rule: HeaderRule): string | undefined {
  const policy = rule.headers.find((header) => header.key === 'Content-Security-Policy');
  return /frame-ancestors ([^;]+)/.exec(policy?.value ?? '')?.[1];
}

describe('vercel.json framing policy', () => {
  it('lets the preview route be framed by its own origin only', async () => {
    const allRules = await headerRules();
    const rules = allRules.filter((rule) => matches(rule.source, '/theme-builder/preview'));
    expect(rules.map(frameAncestors)).toEqual(["'self'"]);
  });

  it('keeps frame-ancestors none on every other route', async () => {
    const rules = await headerRules();
    for (const path of ['/', '/page/button', '/theme-builder', '/theme-builder/preview/extra']) {
      const policies = rules
        .filter((rule) => matches(rule.source, path))
        .map(frameAncestors)
        .filter((value) => value !== undefined);
      expect(policies).toEqual(["'none'"]);
    }
  });

  it('keeps the other security headers on the preview route', async () => {
    const allRules = await headerRules();
    const preview = allRules.find((rule) => rule.source === '/theme-builder/preview');
    expect(preview?.headers.map((header) => header.key).toSorted()).toEqual([
      'Content-Security-Policy',
      'Permissions-Policy',
      'Referrer-Policy',
      'X-Content-Type-Options',
    ]);
  });
});
