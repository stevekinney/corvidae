import { describe, expect, test } from 'bun:test';
import { findCopyLeaks, findLeaks, findTemplateLeaks, leaksIn } from './check-visible-text-leaks';

const ULID = '01HZX3K5M7Q9R2S4T6V8W0YABC';

describe('visible text leaks', () => {
  test.each([
    ['an absolute home path', 'Saved to /Users/someone/.config/weft', 'an absolute path'],
    ['a tilde path', 'Saved to ~/.interborough/secrets', 'an absolute path'],
    ['a relative file path', 'Edit host/scope-gate.ts to change it', 'a relative path'],
    ['a dot-relative path', 'Run ./scripts/start', 'a relative path'],
    ['a ULID', `Run ${ULID} failed`, 'a ULID'],
    ['a secret reference', 'Token is secret:github-token', 'a secret reference'],
    ['a secrets expression', 'Use ${{ secrets.TOKEN }}', 'a secrets expression'],
    ['a workspace reference', 'Depends on workspace:*', 'a workspace reference'],
  ])('reports %s', (_name, text, kind) => {
    expect(leaksIn(text)).toContain(kind);
  });

  test('accepts plain words, a URL, a fraction, a lowercase id, a short code and a secret label', () => {
    for (const text of [
      'Open the configuration file',
      'Read the docs at https://example.com/docs/page',
      'Approve and/or reject 3/4 requests',
      '01hzx3k5m7q9r2s4t6v8w0yabc',
      'ABCDEFGHIJ',
      'Secret: set',
      'The secret is not set',
    ]) {
      expect(leaksIn(text)).toEqual([]);
    }
  });

  test('copy files are read by their string literals, and imports are not text', () => {
    const source = `import { x } from './shared.ts';\nexport const COPY = {\n  clean: 'All good',\n  leak: \`See \${name} in ~/.interborough/workflows\`,\n};`;
    const sites = findCopyLeaks(source);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toStartWith('4 - an absolute path');
  });

  test('templates are read by text nodes and text attributes, not by script, style, comments or expressions', () => {
    const source = [
      '<script>',
      "  import x from '../lib/format.ts'; const path = '/Users/x/y';",
      '</script>',
      '<!-- /Users/x/comment -->',
      '<style>.a { background: url(./a/b.png); }</style>',
      '<p>{value}</p>',
      '<p class="a">Config lives in /home/someone/.config</p>',
      `<Badge label="Run ${ULID}" />`,
      '<Input placeholder="secret:token" />',
      '<a href="./settings/models.ts">Models</a>',
    ].join('\n');
    expect(findTemplateLeaks(source).map((site) => Number.parseInt(site))).toEqual([7, 8, 9]);
  });

  test('a clean template and a non-copy script pass', () => {
    expect(findTemplateLeaks('<p>Nothing to report</p>')).toEqual([]);
    expect(findLeaks("const a = '/Users/x/y';", 'applications/interborough/src/lib/x.ts')).toEqual(
      [],
    );
  });
});
