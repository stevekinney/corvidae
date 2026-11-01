import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  checkInterfaceRules,
  collectViolations,
  emptyStateUsages,
  reconcile,
  run,
  type InterfaceRule,
} from './check-interface-rules.ts';

const roots: string[] = [];

/** A package root holding the given files, removed after the test. */
function packageRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'interface-rules-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rulesIn(files: Record<string, string>): InterfaceRule[] {
  return collectViolations(packageRoot(files)).map((violation) => violation.rule);
}

const component = (body: string): Record<string, string> => ({
  'src/routes/page.svelte': `<script lang="ts">\n  let { x }: { x: string } = $props();\n</script>\n${body}\n`,
});

describe('the copy rules', () => {
  test('ban Engine and Bureau as product words in template text, attributes and copy.ts', () => {
    expect(rulesIn(component('<p>The Bureau did not answer.</p>'))).toEqual(['product-word']);
    expect(rulesIn(component('<p title="Engine status">Hello</p>'))).toEqual(['product-word']);
    expect(
      rulesIn({ 'src/app/copy.ts': "export const A = { x: 'This engine is slow' };" }),
    ).toEqual(['product-word']);
  });

  test('let identifiers, scopes and keys through', () => {
    expect(
      rulesIn({
        'src/app/copy.ts':
          "export const A = { engine: 'Workflow', scope: 'Needs bureau.memory:write to continue' };",
        ...component(
          "<p>{x === 'engine' ? 'Workflow' : 'Summary'}</p><a href=\"/bureau-tasks\">Tasks</a>",
        ),
      }),
    ).toEqual([]);
  });

  test('ban issue and maintainer references', () => {
    expect(rulesIn(component('<p>Tracked in COR-1838.</p>'))).toEqual(['issue-reference']);
    expect(rulesIn(component('<p>See weft#732 for why.</p>'))).toEqual(['issue-reference']);
    expect(rulesIn(component('<p>The maintainers confirmed it.</p>'))).toEqual(['issue-reference']);
  });

  test('ban a lowercase acronym from the Cinder list and accept the canonical spelling', () => {
    expect(rulesIn(component('<button aria-label="Copy id">Copy</button>'))).toEqual([
      'lowercase-acronym',
    ]);
    expect(rulesIn({ 'src/app/copy.ts': "export const A = { x: 'Open the json file' };" })).toEqual(
      ['lowercase-acronym'],
    );
    expect(rulesIn(component('<button aria-label="Copy ID">Copy</button>'))).toEqual([]);
    expect(rulesIn(component('<CodeBlock language="json" code={x} />'))).toEqual([]);
    expect(rulesIn(component('<p>{x.id}</p>'))).toEqual([]);
  });

  test('ban API documentation: ctx., a backticked identifier, and the routing terms', () => {
    expect(rulesIn(component('<p>Use ctx.log to write one.</p>'))).toEqual(['api-documentation']);
    expect(rulesIn(component('<p>Connect a `RemoteWorker` first.</p>'))).toEqual([
      'api-documentation',
    ]);
    expect(rulesIn(component('<p>Shows the worker binding.</p>'))).toEqual(['api-documentation']);
    expect(rulesIn(component('<p>Task queue routing decides it.</p>'))).toEqual([
      'api-documentation',
    ]);
    expect(rulesIn(component('<p>Use <code>ctx.run</code> here.</p>'))).toEqual([
      'api-documentation',
    ]);
  });

  test('ignore comments and test files', () => {
    expect(
      rulesIn({
        ...component('<!-- The Bureau, COR-1 -->\n<p>Hello</p>'),
        'src/routes/page.test.ts': "const text = 'The Bureau';",
        'src/routes/thing.test-harness.svelte': '<p>The Bureau</p>',
        'src/host/server.ts': "export const A = 'The Bureau did not answer.';",
        'src/lib/thing.test-support.ts': "export const A = 'The Bureau did not answer.';",
      }),
    ).toEqual([]);
  });

  test('read the sentences in any TypeScript module under src, not only copy.ts', () => {
    expect(
      rulesIn({ 'src/lib/lease.ts': "export const A = { x: 'This engine holds the lease.' };" }),
    ).toEqual(['product-word']);
    expect(
      rulesIn({ 'src/routes/system/scope.ts': 'export const A = `Read ${x} and the Bureau.`;' }),
    ).toEqual(['product-word']);
    expect(
      rulesIn({ 'src/lib/keys.ts': "export const KEY = 'bureau-tasks'; type T = 'engine';" }),
    ).toEqual([]);
  });

  test('read the arguments of a {@render} tag', () => {
    expect(rulesIn(component("{@render row('Engine down')}"))).toEqual(['product-word']);
    expect(rulesIn(component('{@render row(x, { label: `Bureau ${x}` })}'))).toEqual([
      'product-word',
    ]);
    expect(rulesIn(component('{@render row(x)}'))).toEqual([]);
  });

  test('read the strings of a {@const} tag', () => {
    expect(
      rulesIn(component("{#if x}{@const note = 'The Bureau did not answer.'}<p>{note}</p>{/if}")),
    ).toEqual(['product-word']);
    expect(rulesIn(component("{#if x}{@const kind = x === 'engine'}<p>{kind}</p>{/if}"))).toEqual(
      [],
    );
  });
});

describe('the control and component rules', () => {
  test('fail size="lg" on any element', () => {
    expect(rulesIn(component('<Button size="lg">Save</Button>'))).toEqual(['large-size']);
    expect(rulesIn(component("<Button size={'lg'}>Save</Button>"))).toEqual(['large-size']);
    expect(rulesIn(component('<Button size="sm">Save</Button>'))).toEqual([]);
  });

  test('fail size="lg" chosen by a condition, and pass a condition that never yields it', () => {
    expect(rulesIn(component("<Button size={x ? 'lg' : 'md'}>Save</Button>"))).toEqual([
      'large-size',
    ]);
    expect(
      rulesIn(component("<Button size={x ? 'md' : x === 'a' ? 'lg' : 'sm'}>Save</Button>")),
    ).toEqual(['large-size']);
    expect(rulesIn(component("<Button size={x || 'lg'}>Save</Button>"))).toEqual(['large-size']);
    expect(rulesIn(component("<Button size={x ? 'sm' : 'md'}>Save</Button>"))).toEqual([]);
    expect(rulesIn(component("<Button size={x === 'lg' ? 'sm' : 'md'}>Save</Button>"))).toEqual([]);
  });

  test('fail size="lg" written as a template literal or behind a TypeScript wrapper', () => {
    expect(rulesIn(component('<Button size={`lg`}>Save</Button>'))).toEqual(['large-size']);
    expect(rulesIn(component("<Button size={'lg' as const}>Save</Button>"))).toEqual([
      'large-size',
    ]);
    expect(rulesIn(component("<Button size={'lg' satisfies string}>Save</Button>"))).toEqual([
      'large-size',
    ]);
    expect(rulesIn(component("<Button size={(x ? 'lg' : 'md')!}>Save</Button>"))).toEqual([
      'large-size',
    ]);
    expect(rulesIn(component('<Button size={`l${x}`}>Save</Button>'))).toEqual([]);
    expect(rulesIn(component('<Button size={`md`}>Save</Button>'))).toEqual([]);
    expect(rulesIn(component('<Button size={x as string}>Save</Button>'))).toEqual([]);
  });

  test('fail an EmptyState without a title', () => {
    expect(rulesIn(component('<EmptyState description="Nothing here" kind="done" />'))).toEqual([
      'empty-state-title',
    ]);
    expect(rulesIn(component('<EmptyState title="Nothing here" />'))).toEqual([]);
  });

  test('read the EmptyState usages and the kind each passes', () => {
    const root = packageRoot(
      component('<EmptyState title="A" kind="done" />\n<EmptyState title="B" />'),
    );
    expect(emptyStateUsages(root).map(({ hasKind, hasTitle }) => [hasTitle, hasKind])).toEqual([
      [true, true],
      [true, false],
    ]);
  });
});

describe('the style rules', () => {
  test('fail a class ending in __header or -header in app CSS', () => {
    expect(rulesIn({ 'src/styles/a.css': '.ib-thing__header { display: flex; }' })).toEqual([
      'app-header-class',
    ]);
    expect(
      rulesIn({ 'src/styles/a.css': '@media (width < 40rem) { .weft-chat-header { gap: 0; } }' }),
    ).toEqual(['app-header-class']);
    expect(rulesIn({ 'src/styles/a.css': '.ib-thing__headline { display: flex; }' })).toEqual([]);
  });

  test('fail a header class defined in a component <style> and in a stylesheet beside a route', () => {
    expect(
      rulesIn(component('<p>Hi</p>\n<style>\n  .weft-x__panel-header { margin: 0; }\n</style>')),
    ).toEqual(['app-header-class']);
    expect(rulesIn({ 'src/routes/detail.css': '.weft-x__header { margin: 0; }' })).toEqual([
      'app-header-class',
    ]);
  });

  test('fail a selector that names a .cinder- class, once per class', () => {
    const violations = collectViolations(
      packageRoot({
        'src/styles/a.css':
          '.mine .cinder-badge { margin: 0; }\n.other .cinder-badge, .cinder-select { margin: 0; }',
      }),
    );
    expect(violations.map((violation) => violation.subject)).toEqual([
      '.cinder-badge',
      '.cinder-select',
    ]);
    expect(rulesIn({ 'src/styles/a.css': 'a { color: var(--cinder-text-muted); }' })).toEqual([]);
  });

  test('fail a selector that reaches Cinder through the class list, and a rule nested in another', () => {
    expect(rulesIn({ 'src/styles/a.css': ".mine [class*='cinder-'] { margin: 0; }" })).toEqual([
      'cinder-selector',
    ]);
    expect(rulesIn({ 'src/styles/a.css': '[class^=cinder-button] { margin: 0; }' })).toEqual([
      'cinder-selector',
    ]);
    expect(rulesIn({ 'src/styles/a.css': "[class*='mine-'] { margin: 0; }" })).toEqual([]);
    expect(
      rulesIn({ 'src/styles/a.css': '.mine { margin: 0; .cinder-badge { gap: 0; } }' }),
    ).toEqual(['cinder-selector']);
    expect(
      rulesIn({ 'src/styles/a.css': '.mine { margin: 0; &:hover { .ib-x__header { gap: 0; } } }' }),
    ).toEqual(['app-header-class']);
    expect(
      rulesIn({
        'src/styles/a.css':
          '.mine { margin: 0; @media (width < 40rem) { .cinder-badge { gap: 0; } } }',
      }),
    ).toEqual(['cinder-selector']);
  });

  test('judge an uppercase label by the rule that declares it, not the rule around it', () => {
    expect(
      rulesIn({
        'src/styles/a.css':
          '.outer { color: red; .label { text-transform: uppercase; letter-spacing: 0.05em; } }',
      }),
    ).toEqual(['uppercase-label']);
    expect(
      collectViolations(
        packageRoot({
          'src/styles/a.css':
            '.outer { color: red; .label { text-transform: uppercase; letter-spacing: 0.05em; } }',
        }),
      ).map((violation) => violation.subject),
    ).toEqual(['.label']);
  });

  test('fail an uppercase, letter-spaced label and pass uppercase alone', () => {
    expect(
      rulesIn({
        'src/styles/a.css':
          '.label { text-transform: uppercase; letter-spacing: 0.05em; }\n.quiet { text-transform: uppercase; }',
      }),
    ).toEqual(['uppercase-label']);
  });

  test('report the line of the rule', () => {
    const [violation] = collectViolations(
      packageRoot({ 'src/styles/a.css': '/* note */\n\n.ib-x__header {\n  gap: 0;\n}\n' }),
    );
    expect(violation?.line).toBe(3);
  });
});

describe('the entry lists', () => {
  const violation = {
    rule: 'app-header-class',
    file: 'src/styles/a.css',
    subject: '.ib-x__header',
    line: 1,
  } as const;

  test('reconcile reports an unlisted violation and a stale entry', () => {
    const entry = { rule: violation.rule, file: violation.file, subject: violation.subject };
    expect(reconcile([violation], [entry])).toEqual({ unlisted: [], stale: [] });
    expect(reconcile([violation], []).unlisted).toEqual([violation]);
    expect(reconcile([], [entry]).stale).toEqual([entry]);
  });

  const files = { 'src/styles/a.css': '.ib-x__header { gap: 0; }' };
  const entry = {
    rule: 'app-header-class',
    file: 'src/styles/a.css',
    subject: '.ib-x__header',
    issue: 'COR-1',
  };

  test('an unlisted violation fails the check, and a listed one passes', () => {
    expect(checkInterfaceRules(packageRoot(files)).unlisted).toHaveLength(1);
    const listed = packageRoot({
      ...files,
      'tests/interface-lint-pending.json': JSON.stringify({ entries: [entry] }),
    });
    expect(checkInterfaceRules(listed)).toEqual({ unlisted: [], stale: [] });
  });

  test('a stale pending entry and a stale allowlist entry each fail the check', () => {
    const stale = packageRoot({
      'src/styles/a.css': '.ib-x__body { gap: 0; }',
      'tests/interface-lint-pending.json': JSON.stringify({ entries: [entry] }),
      'tests/interface-lint-allowlist.json': JSON.stringify({
        entries: [{ ...entry, reason: 'no longer needed' }],
      }),
    });
    expect(checkInterfaceRules(stale).stale.map((item) => item.list)).toEqual([
      'tests/interface-lint-allowlist.json',
      'tests/interface-lint-pending.json',
    ]);
  });

  test('run exits 1 and names a stale entry', () => {
    const messages: string[] = [];
    const quiet = console.error;
    console.error = (message: string) => void messages.push(message);
    try {
      expect(
        run(
          packageRoot({
            'src/styles/a.css': '.ib-x__body { gap: 0; }',
            'tests/interface-lint-pending.json': JSON.stringify({ entries: [entry] }),
          }),
        ),
      ).toBe(1);
    } finally {
      console.error = quiet;
    }
    expect(messages[0]).toContain('stale app-header-class entry');
    expect(messages[1]).toContain('0 interface violation(s) and 1 stale entry');
  });

  test('run exits 1 for a violation and 0 once the entry is listed', () => {
    const quiet = console.error;
    console.error = () => undefined;
    try {
      expect(run(packageRoot(files))).toBe(1);
      expect(
        run(
          packageRoot({
            ...files,
            'tests/interface-lint-pending.json': JSON.stringify({ entries: [entry] }),
          }),
        ),
      ).toBe(0);
    } finally {
      console.error = quiet;
    }
  });
});
