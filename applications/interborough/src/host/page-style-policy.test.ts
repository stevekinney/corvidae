/**
 * COR-2771: a Cinder Table with a custom `stackBelow` brings its stacked form in an inline `<style>`
 * element, so the pages Interborough serves must not carry a content security policy that forbids
 * one. The only policy the host sets is on the isolated tool-source documents
 * (`tool-source-routes.ts`), which render no Cinder Table; the application's page (`index.html`,
 * served by `shellResponder` in `host.ts`) carries none. If a page ever gains a policy, it must allow
 * inline styles (`style-src 'unsafe-inline'`, or a nonce the Table's style carries).
 */
import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const hostDirectory = import.meta.dir;
const applicationRoot = join(hostDirectory, '..', '..');

/** Documents the host serves that are not the application's pages, and render no Cinder Table. */
const NON_PAGE_POLICIES = new Set(['src/host/tool-source-routes.ts']);

const POLICY = /content-security-policy/i;

async function hostSources(): Promise<string[]> {
  const entries = await readdir(hostDirectory, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith('.ts') && !/\.(test|test-support)\.ts$/.test(entry))
    .filter((entry) => !entry.includes('.integration.') && !entry.includes('.slow.'))
    .map((entry) => join(hostDirectory, entry));
}

/** Whether a policy's text lets an inline `<style>` element apply. */
function allowsInlineStyle(policy: string): boolean {
  const directives = new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0] !== undefined && tokens[0] !== '')
      .map((tokens) => [tokens[0]!.toLowerCase(), tokens.slice(1)] as const),
  );
  const styles =
    directives.get('style-src-elem') ??
    directives.get('style-src') ??
    directives.get('default-src');
  return styles === undefined || styles.includes("'unsafe-inline'") || styles.includes('*');
}

describe('Interborough page responses and inline styles', () => {
  test('no page the host serves carries a policy that forbids an inline style', async () => {
    const offenders: string[] = [];
    for (const path of await hostSources()) {
      const source = await Bun.file(path).text();
      if (!POLICY.test(source)) continue;
      const name = relative(applicationRoot, path);
      if (!NON_PAGE_POLICIES.has(name)) offenders.push(name);
    }
    expect(offenders).toEqual([]);

    const page = await Bun.file(join(applicationRoot, 'index.html')).text();
    const meta =
      /<meta[^>]+http-equiv=["']content-security-policy["'][^>]*content=["']([^"']*)["']/i.exec(
        page,
      );
    expect(meta === null || allowsInlineStyle(meta[1] ?? '')).toBe(true);
  });

  test('the policy check reads style-src, falling back to default-src', () => {
    expect(allowsInlineStyle("default-src 'self'")).toBe(false);
    expect(allowsInlineStyle("default-src 'self'; style-src 'self' 'unsafe-inline'")).toBe(true);
    expect(allowsInlineStyle("script-src 'self'")).toBe(true);
  });
});
