import { describe, expect, test } from 'bun:test';
import { rejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import type { FetchLike } from './linear.ts';
import { UsageError } from './process-runner.ts';
import {
  draftComment,
  isBlocking,
  parseSections,
  proposeAction,
  readyFindings,
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

function dependencies(
  served: Served,
  extra: Partial<TriageDependencies> = {},
): { dependencies: TriageDependencies; log: ReturnType<typeof fakeLinear>['log'] } {
  const { fetchLike, log } = fakeLinear(served);
  return {
    log,
    dependencies: { fetch: fetchLike, environment: { LINEAR_API_KEY: 'lin_test' }, ...extra },
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
