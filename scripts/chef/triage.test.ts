import { describe, expect, test } from 'bun:test';
import { rejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import type { FetchLike } from './linear.ts';
import { UsageError } from './process-runner.ts';
import {
  citationFindings,
  citationsIn,
  descriptionByteLimit,
  draftComment,
  isBlocking,
  parseSections,
  proposeAction,
  readyFindings,
  type RepositoryView,
  run,
  type TriageDependencies,
  type TriageIssue,
} from './triage.ts';

const goodBody = `## Brief

Do the thing.

## Current behavior

It does not (verified, \`scripts/chef/a.ts:10\`; \`parseThing\` exists).

## Acceptance criteria

- AC1. \`bun test scripts/chef/a.test.ts\` passes.
- AC2. \`bun run lint:root\` passes.

## Decisions

- Use the helper \`parseThing\` (COR-5 decision).

## Out of scope

Nothing.

## Constraints

None.

## Files

- \`scripts/chef/a.ts\`
- \`scripts/chef/a.test.ts\`

## Verification

- \`bun test scripts/chef/a.test.ts\`
- \`bun run lint:root\`

## Delivery boundary

A merged pull request.
`;

function issue(identifier: string, description: string | null, state = 'Backlog'): TriageIssue {
  return {
    identifier,
    title: `Title ${identifier}`,
    description,
    updatedAt: '2026-10-01T00:00:00.000Z',
    state: { name: state, type: state === 'Done' ? 'completed' : 'unstarted' },
  };
}

const codes = (findings: { code: string }[]) => findings.map((finding) => finding.code);

describe('readyFindings', () => {
  test('a complete ticket has no findings', () => {
    expect(readyFindings(goodBody)).toEqual([]);
  });

  test('a missing description is one finding', () => {
    expect(codes(readyFindings(null))).toEqual(['no-description']);
    expect(codes(readyFindings('  '))).toEqual(['no-description']);
  });

  test('missing and empty sections are named; template comments do not count as content', () => {
    const body = goodBody
      .replace('## Constraints\n\nNone.\n\n', '')
      .replace('Nothing.', '<!-- fill me in -->');
    const findings = readyFindings(body);
    expect(findings.map((finding) => finding.message)).toEqual([
      'The template\'s "out of scope" section is empty.',
      'The template\'s "constraints" section is missing.',
    ]);
    expect(findings.every((finding) => !isBlocking(finding))).toBe(true);
  });

  test('only the Definition of Ready blocks: a section it requires is a blocking finding', () => {
    const body = goodBody.replace(/## Delivery boundary\n[\s\S]*$/, '');
    const blocking = readyFindings(body).filter(isBlocking);
    expect(blocking.map((finding) => finding.message)).toEqual([
      'The "delivery boundary" section is missing.',
    ]);
  });

  test('an issue written before the template, meeting the Definition of Ready, is kept', () => {
    // The shape of COR-2102 on 2026-11-09: Brief, Files, unnumbered binary criteria, Verification
    // and a Delivery boundary, with no Current behavior, Decisions, Out of scope or Constraints.
    const body = [
      '## Brief',
      '',
      'One taint threshold for every scan path.',
      '',
      '## Files',
      '',
      '- `scripts/chef/a.ts`',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] Every scan path reads the one threshold.',
      '',
      '## Verification',
      '',
      '- `bun test scripts/chef/a.test.ts`',
      '',
      '## Delivery boundary',
      '',
      'A merged pull request.',
    ].join('\n');
    const findings = readyFindings(body);
    expect(findings.filter(isBlocking)).toEqual([]);
    expect(codes(findings)).toContain('criteria-unnumbered');
    expect(proposeAction('Backlog', findings)).toBe('keep');
  });

  test('criteria must be numbered from AC1 in order', () => {
    const unnumbered = goodBody.replace(/AC\d\./g, '-');
    expect(codes(readyFindings(unnumbered))).toEqual(['criteria-unnumbered']);
    const skipped = goodBody.replace('AC2.', 'AC3.');
    expect(codes(readyFindings(skipped))).toEqual(['criteria-sequence']);
  });

  test('Files needs code spans and Verification needs commands', () => {
    const body = goodBody
      .replace(/- `scripts\/chef\/a\.ts`\n- `scripts\/chef\/a\.test\.ts`/, '- the chef scripts')
      .replace(/- `bun test scripts\/chef\/a\.test\.ts`\n- `bun run lint:root`/, '- run the tests');
    expect(codes(readyFindings(body))).toEqual(['files-no-code-spans', 'verification-no-commands']);
  });

  test('fenced verification commands count', () => {
    const body = goodBody.replace(
      /- `bun test scripts\/chef\/a\.test\.ts`\n- `bun run lint:root`/,
      '```sh\nbun test x\n```',
    );
    expect(readyFindings(body)).toEqual([]);
  });

  test('unanswered markers, Decisions questions and open questions are findings', () => {
    const body = `${goodBody.replace('(COR-5 decision).', 'TBD.\n- Should it retry?')}\n## Open questions\n\n- Which host?\n`;
    expect(codes(readyFindings(body))).toEqual([
      'unanswered-marker',
      'unanswered-question',
      'open-questions',
    ]);
  });

  test('TODO inside a code span is not a marker and "None" open questions are fine', () => {
    const body = `${goodBody.replace('Do the thing.', 'Remove the `TODO` lint.')}\n## Open questions\n\nNone.\n`;
    expect(readyFindings(body)).toEqual([]);
  });

  test('headings inside a fenced block are not sections', () => {
    const sections = parseSections('## Brief\n\n```\n## Not a heading\n```\n');
    expect([...sections.keys()]).toEqual(['brief']);
  });
});

describe('actions and drafts', () => {
  const finding = [{ code: 'no-description', message: 'gone' }];

  test('Backlog refines, Ready demotes, clean keeps', () => {
    expect(proposeAction('Backlog', finding)).toBe('needs-refinement');
    expect(proposeAction('Ready', finding)).toBe('propose-backlog');
    expect(proposeAction('Backlog', [])).toBe('keep');
  });

  test('only needs-refinement and propose-backlog carry a comment draft', () => {
    expect(draftComment('needs-refinement', finding)).toContain('- gone');
    expect(draftComment('propose-backlog', finding)).toContain('move back to Backlog');
    expect(draftComment('keep', [])).toBeUndefined();
  });
});

// Command line ------------------------------------------------------------------------------

interface Served {
  issues?: TriageIssue[];
  byId?: Record<string, TriageIssue>;
  fail?: boolean;
}

function fakeLinear(served: Served) {
  const log: { operation: string; variables: Record<string, any> }[] = [];
  const fetchLike: FetchLike = async (_url, init) => {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as {
      query: string;
      variables: Record<string, any>;
    };
    const operation = /query\s+(\w+)/.exec(body.query)?.[1] ?? '';
    log.push({ operation, variables: body.variables });
    if (served.fail) return new Response('nope', { status: 502 });
    switch (operation) {
      case 'TriageIssues':
        return Response.json({
          data: {
            issues: {
              nodes: served.issues ?? [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      case 'TriageIssue':
        return Response.json({ data: { issue: served.byId?.[body.variables['id']] ?? null } });
      default:
        throw new Error(`Unexpected operation ${operation}`);
    }
  };
  return { fetchLike, log };
}

/** What the fake origin/main holds: the files `goodBody` cites, two real paths and two scripts. */
function repositoryView(): RepositoryView {
  return {
    files: new Set([
      'scripts/chef/a.ts',
      'scripts/chef/a.test.ts',
      'applications/interborough/src/routes/chat/index.ts',
      'scripts/build-release.integration.test.ts',
    ]),
    scripts: new Set(['lint:root', 'validate']),
    ignored: (path) => path.startsWith('tmp/'),
  };
}

function dependencies(
  served: Served,
  extra: Partial<TriageDependencies> = {},
): { dependencies: TriageDependencies; log: ReturnType<typeof fakeLinear>['log'] } {
  const { fetchLike, log } = fakeLinear(served);
  return {
    log,
    dependencies: {
      fetch: fetchLike,
      environment: { LINEAR_API_KEY: 'lin_test' },
      repository: () => repositoryView(),
      ...extra,
    },
  };
}

describe('run', () => {
  test('ready lists Backlog by default and exits 0 when every issue is ready', async () => {
    const { dependencies: deps, log } = dependencies({ issues: [issue('COR-1', goodBody)] });
    const result = await run(['ready'], deps);
    expect(result.code).toBe(0);
    expect(result.output).toBe(
      'ready: 1 issue, 0 with findings.\nCOR-1 [Backlog] keep (0 findings) Title COR-1',
    );
    expect(log[0]?.variables['filter'].state).toEqual({ name: { eq: 'Backlog' } });
    expect(log[0]?.variables['filter'].team).toEqual({ key: { eq: 'COR' } });
  });

  test('ready --json reports findings, the action and the comment draft with exit 1', async () => {
    const { dependencies: deps } = dependencies({ issues: [issue('COR-2', '## Brief\n\nx')] });
    const result = await run(['ready', '--json'], deps);
    const parsed = JSON.parse(result.output);
    expect(result.code).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues[0].action).toBe('needs-refinement');
    expect(parsed.issues[0].findings.length).toBe(8);
    expect(parsed.issues[0].comment).toContain('Definition of Ready');
  });

  test('--issue reads each issue; an unknown one is a usage error', async () => {
    const { dependencies: deps } = dependencies({ byId: { 'COR-1': issue('COR-1', goodBody) } });
    const single = await run(['ready', '--issue', 'cor-1'], deps);
    expect(single.code).toBe(0);
    expect(await rejectionOf(run(['ready', '--issue', 'COR-99'], deps))).toBeInstanceOf(UsageError);
  });

  test('Linear unavailable is exit 3, including a missing key', async () => {
    const down = dependencies({ fail: true });
    const unreachable = await run(['ready'], down.dependencies);
    expect(unreachable.code).toBe(3);
    const keyless = dependencies({}, { environment: {}, resolveKey: () => undefined });
    const result = await run(['ready'], keyless.dependencies);
    expect(result.code).toBe(3);
    expect(result.output).toContain('LINEAR_API_KEY is unavailable');
  });

  test('usage errors, including the commands and flag that were removed', async () => {
    const { dependencies: deps } = dependencies({});
    for (const argv of [
      [],
      ['bogus'],
      ['stale'],
      ['done'],
      ['ready', 'extra'],
      ['ready', '--since', '2026-01-01'],
      ['ready', '--shadow'],
      ['ready', '--limit', '0'],
      ['ready', '--issue', 'nope'],
    ])
      expect(await rejectionOf(run(argv, deps))).toBeInstanceOf(UsageError);
  });
});

describe('the description size limit', () => {
  const padding = (bytes: number) => `\n\n${'x'.repeat(bytes)}\n`;

  test('a description over the limit is a blocking finding that names its size and the limit', () => {
    const body = goodBody + padding(descriptionByteLimit);
    const findings = readyFindings(body);
    expect(codes(findings)).toEqual(['description-too-large']);
    expect(isBlocking(findings[0]!)).toBe(true);
    expect(findings[0]?.message).toContain(`${Buffer.byteLength(body.trim())} bytes`);
    expect(findings[0]?.message).toContain(String(descriptionByteLimit));
  });

  test('the limit counts bytes, not characters', () => {
    const wide = `${goodBody}\n\n${'é'.repeat(descriptionByteLimit / 2)}\n`;
    expect(wide.length).toBeLessThan(descriptionByteLimit);
    expect(codes(readyFindings(wide))).toEqual(['description-too-large']);
    expect(readyFindings(goodBody + padding(100))).toEqual([]);
  });

  test('shared programme text replaced by its link does not count', () => {
    const preamble = `\n## Shared programme text\n\nSee https://linear.app/x/document/chat-board-abc.\n${'y'.repeat(20_000)}\n`;
    expect(readyFindings(goodBody + preamble)).toEqual([]);
    const unlinked = `\n## Shared programme text\n\n${'y'.repeat(20_000)}\n`;
    expect(codes(readyFindings(goodBody + unlinked))).toEqual(['description-too-large']);
  });
});

describe('citations resolved against origin/main', () => {
  const view = repositoryView();
  const messages = (text: string) => citationFindings(text, view).map((finding) => finding.message);

  test('a description whose citations all resolve has no findings', () => {
    expect(citationFindings(goodBody, view)).toEqual([]);
  });

  test('a path that is not on main is named; a real directory and a :line suffix resolve', () => {
    expect(
      messages(
        'See `applications/interborough/src/routes/chats` and `applications/interborough/src/routes/chat`, `scripts/chef/a.ts:10`, `.claude/skills/x.md`.',
      ),
    ).toEqual([
      'The issue cites `applications/interborough/src/routes/chats`, which is not on origin/main.',
      'The issue cites `.claude/skills/x.md`, which is not on origin/main.',
    ]);
  });

  test('a scripts/ path resolves relative to a workspace too', () => {
    const workspace = {
      ...view,
      files: new Set([...view.files, 'applications/interborough/scripts/design-review-capture.ts']),
    };
    expect(citationFindings('`scripts/design-review-capture.ts`', workspace)).toEqual([]);
    expect(messages('`scripts/design-review-capture.ts`')).toHaveLength(1);
  });

  test('a test file is found by its name anywhere in the tree, and a wrong name is named', () => {
    expect(
      messages('Run `build-release.test.ts` and `build-release.integration.test.ts`.'),
    ).toEqual([
      'The issue cites the test file `build-release.test.ts`, which no path on origin/main has.',
    ]);
  });

  test('bun commands: the script path and the bun run name both resolve', () => {
    expect(
      messages(
        '`bun scripts/nope.ts --flag`\n`bun run with-turborepo-cache`\n`bun run validate`\n`cd applications/interborough && bun run dev`',
      ),
    ).toEqual([
      'The issue cites `scripts/nope.ts`, which is not on origin/main.',
      'The issue cites `bun run with-turborepo-cache`, which is not a script of the root package.json on origin/main.',
    ]);
  });

  test('fenced command lines are read; globs, placeholders, URLs and plain prose are not', () => {
    const text = [
      '```sh',
      'bun test scripts/chef/missing.test.ts',
      '```',
      'Prose mentions scripts/chef/prose-only.ts, `scripts/chef/*.ts`, `tmp/chef/briefs/<ID>.md` and `https://example.com/scripts/x.ts`.',
      'Also `other-repo/src/a.ts` and `scripts/chef/a.ts#L12`.',
    ].join('\n');
    expect(messages(text)).toEqual([
      'The issue cites `scripts/chef/missing.test.ts`, which is not on origin/main.',
    ]);
  });

  test('a path under an ignored folder fails unless the line attaches an upload', () => {
    const findings = citationFindings(
      '- The rows are in `tmp/cinder-audit/rows.md`.\n- Stylesheet `tmp/proposed-cinder-3.css` (https://uploads.linear.app/abc/proposed-cinder-3.css).',
      view,
    );
    expect(findings.map((finding) => finding.code)).toEqual(['citation-ignored']);
    expect(findings[0]?.message).toContain('`tmp/cinder-audit/rows.md`');
    expect(findings[0]?.message).toContain('Commit it, or attach it');
  });

  test('a path an issue says it creates or writes need not exist yet', () => {
    expect(
      messages('Create `scripts/chef/new-thing.ts`. The run writes `tmp/chef/out/log.txt`.'),
    ).toEqual([]);
  });

  test('citationsIn lists each citation once, with its kind', () => {
    expect(
      citationsIn(
        '`scripts/chef/a.ts` and `scripts/chef/a.ts` and `bun run validate` `a.test.ts`',
      ).map((citation) => `${citation.kind}:${citation.value}`),
    ).toEqual(['path:scripts/chef/a.ts', 'script:validate', 'test:a.test.ts']);
  });

  test('run fails an issue with a missing citation, and reads no repository when none are cited', async () => {
    const bad = goodBody.replace('`scripts/chef/a.ts`', '`scripts/chef/b.ts`');
    const { dependencies: deps } = dependencies({ issues: [issue('COR-1', bad)] });
    const result = await run(['ready'], deps);
    expect(result.code).toBe(1);
    expect(result.output).toContain('citation-missing');
    expect(result.output).toContain('`scripts/chef/b.ts`');
    let loaded = 0;
    const plain = dependencies(
      { issues: [issue('COR-2', '## Brief\n\nNothing cited here.')] },
      {
        repository: () => {
          loaded += 1;
          return repositoryView();
        },
      },
    );
    await run(['ready'], plain.dependencies);
    expect(loaded).toBe(0);
  });
});
