import { describe, expect, test } from 'bun:test';
import { throwingRejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import {
  buildLedger,
  parseBoardMap,
  parseCanvasRows,
  renderLedger,
  renderRowsFile,
  run,
  searchIssues,
} from './design-ledger.ts';
import type { FetchLike } from './linear.ts';

const canvasIndex = `class Component extends DCLogic {
renderVals() {
var rows = [
['00a', 'Ticketing rule', 'Cinder first: it’s the rule', 'Decided'],
['11a', 'Chat', 'Rebuild New chat around the composer'],
['12a', 'Chat', 'Composer bar shows model, effort and permission mode'],
['19b', 'Every list page', 'Adopt ListDetail'],
['24c', 'Status', 'Status is a dot and a word', 'Decided']
];`;

const issue = (identifier: string, description: string, state = 'Done') => ({
  identifier,
  title: `Issue ${identifier}`,
  description,
  state: { name: state },
});

describe('parseCanvasRows', () => {
  test('reads the rows array of a canvas index board', () => {
    expect(parseCanvasRows(canvasIndex)).toEqual([
      { id: '00a', area: 'Ticketing rule', text: 'Cinder first: it’s the rule', status: 'Decided' },
      { id: '11a', area: 'Chat', text: 'Rebuild New chat around the composer', status: '' },
      {
        id: '12a',
        area: 'Chat',
        text: 'Composer bar shows model, effort and permission mode',
        status: '',
      },
      { id: '19b', area: 'Every list page', text: 'Adopt ListDetail', status: '' },
      { id: '24c', area: 'Status', text: 'Status is a dot and a word', status: 'Decided' },
    ]);
  });

  test('reads the Markdown index form, one row per bullet', () => {
    expect(
      parseCanvasRows(
        '- 11a | Chat | Rebuild New chat | \n- 24c | Status | Dot and word | Decided',
      ),
    ).toEqual([
      { id: '11a', area: 'Chat', text: 'Rebuild New chat', status: '' },
      { id: '24c', area: 'Status', text: 'Dot and word', status: 'Decided' },
    ]);
  });
});

describe('buildLedger', () => {
  const rows = parseCanvasRows(canvasIndex);

  test('classifies each row by where the issues carry it', () => {
    const ledger = buildLedger(rows, [
      issue(
        'COR-1',
        '## Acceptance criteria\n\n- [ ] 11a: New chat is built around the composer.\n\n## Design source\n\n* **11a** (Chat): x\n* **12a** (Chat): y',
      ),
      issue(
        'COR-2',
        '## Acceptance criteria\n\n- [ ] It works.\n\nDeferred: 19b, because the list pages are redone later.',
      ),
    ]);
    const byId = new Map(ledger.rows.map((row) => [row.id, row]));
    expect(byId.get('11a')).toMatchObject({ coverage: 'criterion', criterionIssues: ['COR-1'] });
    expect(byId.get('12a')).toMatchObject({ coverage: 'context-only', contextIssues: ['COR-1'] });
    expect(byId.get('19b')).toMatchObject({ coverage: 'deferred', deferredIssues: ['COR-2'] });
    expect(byId.get('24c')).toMatchObject({ coverage: 'unassigned' });
    expect(byId.get('00a')).toMatchObject({ coverage: 'rule' });
    expect(ledger.gaps.map((row) => row.id)).toEqual(['12a', '24c']);
  });

  test('a row in an open issue counts, so a split that drops a row shows as a gap', () => {
    const ledger = buildLedger(rows, [
      issue('COR-3', '## Acceptance criteria\n\n- [ ] 12a: composer bar.', 'Todo'),
    ]);
    expect(ledger.rows.find((row) => row.id === '12a')?.coverage).toBe('criterion');
    expect(ledger.gaps.map((row) => row.id)).toEqual(['11a', '19b', '24c']);
  });
});

describe('revisions, board maps and the rows file', () => {
  const rows = parseCanvasRows(canvasIndex);

  test('a revision that replaces a criterion moves the row it names', () => {
    const ledger = buildLedger(rows, [
      issue(
        'COR-4',
        '## Acceptance criteria\n\n- [ ] 11a: built.\n\n## Revision 2026-11-01\n\nRow 11a moved to COR-5; this issue now carries 12a.',
      ),
    ]);
    const byId = new Map(ledger.rows.map((row) => [row.id, row.coverage]));
    expect(byId.get('11a')).toBe('context-only');
    expect(byId.get('12a')).toBe('criterion');
  });

  test('reads a board map from pairs or drift headings, and writes every row in order', () => {
    const boards = parseBoardMap(
      '11a | NewChat.dc.html\n## ChatSession (index rows: 12a, 11a)\n## SidebarBefore (index rows: 19b)\n## ListPagePattern (index rows: 19b)',
    );
    expect(boards.get('11a')).toBe('NewChat');
    expect(boards.get('12a')).toBe('ChatSession');
    expect(renderRowsFile(rows, boards)).toBe(
      [
        '00a | Main | Cinder first: it’s the rule [Decided]',
        '11a | NewChat | Rebuild New chat around the composer [Prototyped]',
        '12a | ChatSession | Composer bar shows model, effort and permission mode [Prototyped]',
        '19b | ListPagePattern | Adopt ListDetail [Prototyped]',
        '24c | Main | Status is a dot and a word [Decided]',
        '',
      ].join('\n'),
    );
  });

  test('replaces a literal pipe in the text', () => {
    expect(renderRowsFile([{ id: '01a', area: 'A', text: 'a | b', status: '' }], new Map())).toBe(
      '01a | Main | a / b [Prototyped]\n',
    );
  });
});

describe('renderLedger', () => {
  test('prints one line per row and a summary', () => {
    const text = renderLedger(
      buildLedger(parseCanvasRows(canvasIndex), [
        issue('COR-1', '## Acceptance criteria\n\n- [ ] 11a: done'),
      ]),
    );
    expect(text).toContain('11a | criterion | COR-1');
    expect(text).toContain('12a | unassigned |');
    expect(text).toContain('3 gaps');
  });
});

describe('searchIssues and run', () => {
  const pages = [
    {
      issues: {
        nodes: [
          issue(
            'COR-1',
            '## Acceptance criteria\n\n- [ ] 11a: done\n- [ ] 12a: done\n- [ ] 19b: done\n- [ ] 24c: done',
          ),
        ],
        pageInfo: { hasNextPage: true, endCursor: 'c1' },
      },
    },
    {
      issues: {
        nodes: [issue('COR-2', 'Nothing here.')],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  ];
  const fetchPages = (): { fetch: FetchLike; bodies: unknown[] } => {
    const bodies: unknown[] = [];
    let index = 0;
    return {
      bodies,
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(typeof init.body === 'string' ? init.body : '{}'));
        const page = pages[index];
        index += 1;
        return new Response(JSON.stringify({ data: page }), { status: 200 });
      },
    };
  };
  const dependencies = (fetch: FetchLike) => ({ fetch, environment: { LINEAR_API_KEY: 'key' } });

  test('pages through every issue whose description names the canvas', async () => {
    const { fetch, bodies } = fetchPages();
    const { createClient } = await import('./linear.ts');
    const found = await searchIssues(createClient(dependencies(fetch)), 'GDeC387KnFkpSQoLz86jLw');
    expect(found.map((entry) => entry.identifier)).toEqual(['COR-1', 'COR-2']);
    expect(JSON.stringify(bodies[0])).toContain('GDeC387KnFkpSQoLz86jLw');
    expect(JSON.stringify(bodies[1])).toContain('"after":"c1"');
  });

  test('exits 0 when every design row is a criterion or deferred, 1 with gaps, 2 on bad usage', async () => {
    const indexPath = `${import.meta.dir}/.design-ledger-test-index.txt`;
    await Bun.write(indexPath, canvasIndex);
    try {
      const full = await run(
        ['--index', indexPath, '--canvas', 'GDeC387KnFkpSQoLz86jLw'],
        dependencies(fetchPages().fetch),
      );
      expect(full.code).toBe(0);
      const gaps = await run(
        ['--index', indexPath, '--canvas', 'GDeC387KnFkpSQoLz86jLw'],
        dependencies(async () => new Response(JSON.stringify({ data: pages[1] }), { status: 200 })),
      );
      expect(gaps.code).toBe(1);
      expect(gaps.output).toContain('11a | unassigned');
      expect(
        await throwingRejectionOf(run(['--canvas', 'x'], dependencies(fetchPages().fetch))),
      ).toThrow('Usage');
    } finally {
      await Bun.file(indexPath).delete();
    }
  });
});
