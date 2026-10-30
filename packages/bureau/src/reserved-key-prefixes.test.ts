import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';
import { BUREAU_RESERVED_KEY_PREFIXES } from './reserved-key-prefixes';

/**
 * Constants named `*PREFIX` that hold something other than a storage key
 * prefix: owner-label and workflow-id prefixes. Adding to this list is a
 * reviewed edit.
 */
const NOT_STORAGE_KEY_PREFIXES = new Set([
  'AUDIT_SCHEDULE_OWNER_PREFIX',
  'AUDIT_SESSION_OWNER_PREFIX',
  'AUDIT_AGENT_OWNER_PREFIX',
  'AUDIT_WORKFLOW_OWNER_PREFIX',
  'CONTROLLER_PREFIX',
  'ATTEMPT_RUN_PREFIX',
]);

const declaration = /\bconst\s+([A-Z][A-Z0-9_]*PREFIX)\s*=\s*'([a-z][a-z0-9-]*:[^']*)'/g;

async function readSources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for await (const path of new Glob('**/*.ts').scan({ cwd: import.meta.dir })) {
    if (/\.test(-support)?\.ts$|\.test-support\.ts$|^(test|testing)\//.test(path)) continue;
    sources.set(path, await Bun.file(`${import.meta.dir}/${path}`).text());
  }
  return sources;
}

describe('BUREAU_RESERVED_KEY_PREFIXES', () => {
  it('lists every key-prefix constant declared in the source', async () => {
    const listed = new Set(BUREAU_RESERVED_KEY_PREFIXES);
    const unlisted: string[] = [];
    let found = 0;
    for (const [path, text] of await readSources()) {
      for (const [, name, value] of text.matchAll(declaration)) {
        if (name === undefined || value === undefined || NOT_STORAGE_KEY_PREFIXES.has(name)) {
          continue;
        }
        found += 1;
        if (!listed.has(value)) unlisted.push(`${path}: ${name} = '${value}'`);
      }
    }
    expect(found).toBeGreaterThan(30);
    expect(unlisted).toEqual([]);
  });

  it('lists only prefixes the source still declares', async () => {
    const sourceMap = await readSources();
    const sources = [...sourceMap.values()];
    const stale = BUREAU_RESERVED_KEY_PREFIXES.filter(
      (prefix) => !sources.some((text) => text.includes(`'${prefix}`)),
    );
    expect(stale).toEqual([]);
  });

  it('has no duplicates', () => {
    expect(new Set(BUREAU_RESERVED_KEY_PREFIXES).size).toBe(BUREAU_RESERVED_KEY_PREFIXES.length);
  });
});
