import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  checkSpecification,
  EXTENSION_SPECIFICATIONS,
  EXTENSION_URI_BASE,
  runCli,
} from './check-a2a-extension-schemas.ts';

const NAME = 'durable-history-v1.md';
const URI = `${EXTENSION_URI_BASE}${NAME}`;
const SCHEMA =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"cursor":{"type":"string"}},"required":["cursor"]}';

/** Builds a minimal specification around the given blocks, stating its URI. */
function specification(...blocks: string[]): { name: string; text: string } {
  return { name: NAME, text: [`URI: \`${URI}\``, ...blocks].join('\n\n') };
}

function fence(body: string): string {
  return ['```json', body, '```'].join('\n');
}

const GOOD_SCHEMA = `<!-- schema: metadata -->\n\n${fence(SCHEMA)}`;
const GOOD_EXAMPLE = `<!-- example: metadata at /a -->\n\n${fence('{"a":{"cursor":"c"}}')}`;

describe('check-a2a-extension-schemas', () => {
  it('passes the three real specifications', async () => {
    const directory = join(import.meta.dir, '..', 'documentation', 'a2a', 'extensions');
    for (const name of EXTENSION_SPECIFICATIONS) {
      const text = await Bun.file(join(directory, name)).text();
      expect(checkSpecification({ name, text })).toEqual([]);
    }
  });

  it('exits zero from the command-line entry on the real specifications', async () => {
    const originalLog = console.log;
    console.log = (): void => {};
    try {
      expect(await runCli()).toBe(0);
    } finally {
      console.log = originalLog;
    }
  });

  it('rejects a cleanup example whose state contradicts its acknowledgement', async () => {
    const directory = join(import.meta.dir, '..', 'documentation', 'a2a', 'extensions');
    const text = await Bun.file(join(directory, 'cleanup-v1.md')).text();
    const needle = '"state": "cleaned-up"';
    expect(text).toContain(needle);
    const broken = text.replace(needle, '"state": "cleanup-failed"');
    const problems = checkSpecification({ name: 'cleanup-v1.md', text: broken });
    expect(problems.some((problem) => problem.includes('fails its schema'))).toBe(true);
  });

  it('accepts a minimal valid specification', () => {
    expect(checkSpecification(specification(GOOD_SCHEMA, GOOD_EXAMPLE))).toEqual([]);
  });

  it('substitutes {uri} in a pointer with the escaped URI', () => {
    const example = `<!-- example: metadata at /m/{uri} -->\n\n${fence(
      JSON.stringify({ m: { [URI]: { cursor: 'c' } } }),
    )}`;
    expect(checkSpecification(specification(GOOD_SCHEMA, example))).toEqual([]);
  });

  it('fails an example that violates its schema', () => {
    const bad = `<!-- example: metadata at /a -->\n\n${fence('{"a":{"other":1}}')}`;
    const problems = checkSpecification(specification(GOOD_SCHEMA, bad));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('fails its schema');
  });

  it('fails a pointer that resolves to nothing', () => {
    const missing = `<!-- example: metadata at /nope/0 -->\n\n${fence('{"a":{"cursor":"c"}}')}`;
    expect(checkSpecification(specification(GOOD_SCHEMA, missing))[0]).toContain(
      'resolves to nothing',
    );
  });

  it('fails a schema that does not compile', () => {
    const broken = `<!-- schema: metadata -->\n\n${fence(
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"not-a-type"}',
    )}`;
    const problems = checkSpecification(specification(broken, GOOD_EXAMPLE));
    expect(problems.some((problem) => problem.includes('does not compile'))).toBe(true);
  });

  it('fails a schema that is not draft 2020-12', () => {
    const old = `<!-- schema: metadata -->\n\n${fence('{"$schema":"http://json-schema.org/draft-07/schema#"}')}`;
    const problems = checkSpecification(specification(old, GOOD_EXAMPLE));
    expect(problems.some((problem) => problem.includes('must declare'))).toBe(true);
  });

  it('fails a document with no schema, no example, or no URI', () => {
    expect(checkSpecification(specification(GOOD_EXAMPLE)).join('\n')).toContain('no schema block');
    expect(checkSpecification(specification(GOOD_SCHEMA)).join('\n')).toContain('no example block');
    const noUri = { name: NAME, text: [GOOD_SCHEMA, GOOD_EXAMPLE].join('\n\n') };
    expect(checkSpecification(noUri).join('\n')).toContain('never states its URI');
  });

  it('fails an example naming an unknown schema and a marker without a fence', () => {
    const unknown = `<!-- example: nothing at /a -->\n\n${fence('{"a":{}}')}`;
    expect(
      checkSpecification(specification(GOOD_SCHEMA, GOOD_EXAMPLE, unknown)).join('\n'),
    ).toContain('does not exist');
    const orphan = '<!-- schema: lonely -->\n\nplain text';
    expect(
      checkSpecification(specification(GOOD_SCHEMA, GOOD_EXAMPLE, orphan)).join('\n'),
    ).toContain('not followed by a json fence');
  });
});
