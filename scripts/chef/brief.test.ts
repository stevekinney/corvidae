import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import {
  charterRules,
  designLinks,
  designRowIds,
  pathsIn,
  renderBrief,
  rowCarriage,
  run,
  sectionOf,
  verificationCommands,
} from './brief.ts';
import type { FetchLike, IssueSummary } from './linear.ts';
import { UsageError } from './process-runner.ts';

const description = [
  'Some intro.',
  '',
  '## Execution brief',
  'Add the thing in `scripts/chef/thing.ts` and test it.',
  '### Detail',
  'Nested text stays in the section.',
  '',
  '## Acceptance criteria',
  '- It works.',
  '- It is tested.',
  '',
  '## Files',
  '- `scripts/chef/thing.ts:12`',
  '- `scripts/chef/thing.test.ts`',
  '- `not-a-path`',
  '',
  '## Notes',
  'Ignore me.',
].join('\n');

const issue = (text: string | null): IssueSummary => ({
  id: 'u1',
  identifier: 'COR-7',
  title: 'Add the thing',
  description: text,
  updatedAt: '2026-10-23T00:00:00Z',
  state: { id: 's', name: 'Todo' },
  team: { id: 't', key: 'COR', parent: null },
});

let sandbox: string;
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'brief-'));
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('designRowIds and designLinks', () => {
  test('finds bold row IDs and leading row IDs, once each, in order', () => {
    expect(
      designRowIds('* **11a** (Chat): x\n* **12a** (Chat): y\n- 04f: z\n* **11a** again'),
    ).toEqual(['11a', '12a', '04f']);
  });

  test('finds claude.ai artifact links once each', () => {
    const text =
      'See [canvas](https://claude.ai/artifact/GDeC387KnFkpSQoLz86jLw) and <https://claude.ai/artifact/GDeC387KnFkpSQoLz86jLw>.';
    expect(designLinks(text)).toEqual(['https://claude.ai/artifact/GDeC387KnFkpSQoLz86jLw']);
  });
});

describe('rowCarriage', () => {
  test('a dated revision moves rows in and out, in order', () => {
    const body = [
      '## Acceptance criteria',
      '- [ ] 11a: built.',
      '- [ ] 12a: built.',
      '',
      '## Revision 2026-10-31 (chef, split at readiness)',
      '',
      'This issue is now rows 11a and 19b. Row 12a moved to COR-1967.',
      '',
      '## Revision 2026-11-01',
      '',
      '- Dropped 19b: owner decision.',
    ].join('\n');
    const carriage = rowCarriage(body, ['11a', '12a', '19b']);
    expect([...carriage.criteria]).toEqual(['11a']);
    expect(carriage.deferred.size).toBe(0);
  });
});

describe('sectionOf and pathsIn', () => {
  test('takes a section with its nested headings, up to the next peer heading', () => {
    const section = sectionOf(description, /execution\s+brief/i) ?? '';
    expect(section).toContain('Add the thing');
    expect(section).toContain('Nested text');
    expect(section).not.toContain('It works');
    expect(sectionOf(description, /nonexistent/)).toBeUndefined();
  });

  test('finds path-like code spans only and drops line suffixes', () => {
    expect(pathsIn(description)).toEqual(['scripts/chef/thing.ts', 'scripts/chef/thing.test.ts']);
  });
});

describe('renderBrief', () => {
  const options = { paths: [], verify: [], model: 'Sonnet' };

  test('holds the sections, the files, the default verification and every charter rule', () => {
    const text = renderBrief(issue(description), options);
    expect(text).toContain('# COR-7: Add the thing');
    expect(text).toContain('## Execution brief\n\nAdd the thing');
    expect(text).toContain('## Acceptance criteria\n\n- It works.');
    expect(text).not.toContain('Ignore me');
    expect(text).toContain('- `scripts/chef/thing.ts`');
    expect(text).toContain('- `bun run lint:root`');
    expect(text).toContain('Model: Sonnet');
    for (const rule of charterRules) expect(text).toContain(rule);
  });

  test('explicit paths and verification commands replace the derived ones', () => {
    const text = renderBrief(issue(description), {
      ...options,
      paths: ['a/b.ts'],
      verify: ['bun test a'],
    });
    expect(text).toContain('- `a/b.ts`');
    expect(text).not.toContain('thing.test.ts');
    expect(text).toContain('- `bun test a`');
    expect(text).not.toContain('- `bun run typecheck:root`');
  });

  test('explicit verification commands always keep the root lint, once', () => {
    expect(verificationCommands(['bun test a'])).toEqual(['bun test a', 'bun run lint:root']);
    expect(verificationCommands(['bun run lint:root', 'bun test a'])).toEqual([
      'bun run lint:root',
      'bun test a',
    ]);
    const text = renderBrief(issue(description), { ...options, verify: ['bun test a'] });
    expect(text).toContain('- `bun test a`\n- `bun run lint:root`');
  });

  test('a description with neither heading is included whole, and an empty one says so', () => {
    expect(renderBrief(issue('Just prose about `src/x/y.ts`.'), options)).toContain(
      'Just prose about',
    );
    expect(renderBrief(issue('Just prose about `src/x/y.ts`.'), options)).toContain('`src/x/y.ts`');
    expect(renderBrief(issue(null), options)).toContain('no description');
  });

  test('a description with criteria but no execution-brief heading is included whole', () => {
    const body =
      '## Scope\n\nRemove `a/b.ts`.\n\n## Acceptance criteria\n\n- It is gone.\n\n## Verification\n\n`bun test a`';
    const text = renderBrief(issue(body), options);
    expect(text).toContain('Remove `a/b.ts`.');
    expect(text).toContain('- It is gone.');
    expect(text).toContain('`bun test a`');
    expect(text).not.toContain('no description');
  });

  test('carries the design rows even when an execution brief would hide them', () => {
    const body = [
      '## Execution brief',
      'Build the chat header.',
      '',
      '## Acceptance criteria',
      '- [ ] 11a: New chat is built around the composer (board NewChat).',
      '',
      '## Design source',
      '',
      'Prototypes: [canvas](https://claude.ai/artifact/GDeC387KnFkpSQoLz86jLw). Index rows:',
      '* **11a** (Chat): Rebuild New chat around the composer',
      '* **12a** (Chat): Composer bar shows model, effort and permission mode',
    ].join('\n');
    const text = renderBrief(issue(body), options);
    expect(text).toContain('## Design');
    expect(text).toContain('**12a** (Chat): Composer bar');
    expect(text).toContain('https://claude.ai/artifact/GDeC387KnFkpSQoLz86jLw');
    expect(text).toContain('Rows not named in the acceptance criteria: 12a.');
    expect(text).not.toContain('Rows not named in the acceptance criteria: 11a');
    expect(text).toContain('bun scripts/design-review-rows.ts');
    expect(text).toContain('`unverified` block the pull request');
    expect(text).toContain('tmp/chef/briefs/COR-7/boards/');
  });

  test('does not repeat the rows when the whole description is already the brief', () => {
    const body =
      '## Acceptance criteria\n\n- [ ] 11a: done\n\n## Design source\n\n* **11a** (Chat): one\n* **12a** (Chat): two';
    const text = renderBrief(issue(body), options);
    expect(text.split('**12a** (Chat): two')).toHaveLength(2);
    expect(text).toContain('Rows not named in the acceptance criteria: 12a.');
  });

  test('carries a recorded deferral and does not ask the worker to build that row', () => {
    const body = [
      '## Execution brief',
      'Build the chat list.',
      '',
      '## Acceptance criteria',
      '- [ ] 11a: built.',
      '',
      '## Design source',
      '',
      '* **11a** (Chat): one',
      '* **19b** (Every list page): two',
      '',
      '## Scope notes',
      '',
      'Deferred: 19b, because the list pages are redone in COR-2001.',
    ].join('\n');
    const text = renderBrief(issue(body), options);
    expect(text).toContain('Deferred on this issue, do not build: 19b (Deferred: 19b, because');
    expect(text).not.toContain('Rows not named in the acceptance criteria');
  });

  test('tells the worker that a rows-file board is the saved file stem', () => {
    const body = '## Design source\n\n* **11a** (Chat): one';
    expect(renderBrief(issue(body), options)).toContain('the file stem you saved under `boards/`');
  });

  test('a canvas link with no design section takes its rows from the whole description', () => {
    const body =
      'Build it per https://claude.ai/artifact/GDeC387KnFkpSQoLz86jLw.\n\n## Acceptance criteria\n\n- [ ] 11a: built.\n\n## Notes\n\n- 12a: also on the board.';
    const text = renderBrief(issue(body), options);
    expect(text).toContain('Rows not named in the acceptance criteria: 12a.');
  });

  test('a row a revision moved elsewhere is reported as moved, not as a missing criterion', () => {
    const body = [
      '## Execution brief',
      'Build the chat list.',
      '',
      '## Acceptance criteria',
      '- [ ] 11b: built.',
      '',
      '## Design source',
      '',
      '* **11a** (Chat): one',
      '* **11b** (Chat): two',
      '',
      '## Revision 2026-11-01',
      '',
      'Row 11a moved to COR-8.',
    ].join('\n');
    const text = renderBrief(issue(body), options);
    expect(text).toContain(
      'Moved off this issue by a revision, do not build: 11a (Row 11a moved to COR-8.)',
    );
    expect(text).not.toContain('Rows not named in the acceptance criteria');
  });

  test('an issue with no design gets no design section', () => {
    expect(renderBrief(issue(description), options)).not.toContain('## Design');
  });

  test('cuts a very long description and says so', () => {
    const text = renderBrief(issue('x'.repeat(40_000)), options);
    expect(text).toContain('description cut at 16000');
    expect(text.length).toBeLessThan(20_000);
  });
});

describe('charter rules', () => {
  test('leave merging to the coordinator', () => {
    const rules = charterRules.join('\n');
    expect(rules).not.toContain('merge-gate.ts --pr');
    expect(rules).toContain('You do not merge');
  });

  test('stay in step with references/execution-record.md', () => {
    const record = readFileSync(
      join(import.meta.dir, '../../.agents/skills/chef/references/execution-record.md'),
      'utf8',
    );
    for (const phrase of [
      'focused checks',
      'answer every thread before merge',
      'at most three rounds',
      'End a turn only on a state change',
      'defect-classes.md',
      'review-threads.ts classes',
      'return evidence for causal reassessment',
    ]) {
      expect(record.replace(/\s+/g, ' ')).toContain(phrase);
      expect(charterRules.join('\n').toLowerCase()).toContain(phrase.toLowerCase());
    }
  });
});

describe('report rule', () => {
  const rule = charterRules.find((candidate) => candidate.startsWith('**Report:**'));

  test('makes the final message the report and keeps files out of it', () => {
    expect(rule).toBeDefined();
    expect(rule).toContain('final message is the report');
    expect(rule).toContain('at most 15 lines');
    expect(rule).toContain('do not create a `report.md`');
    expect(rule).toContain('tmp/chef/<package>/round-<n>/');
  });

  test('no charter rule requires writing a report file', () => {
    expect(charterRules.join('\n')).not.toMatch(/write (?:the )?(?:full )?report/i);
  });

  test('the brief a worker receives carries the report rule', () => {
    const text = renderBrief(issue(description), { paths: [], verify: [], model: 'Sonnet' });
    expect(text).toContain(rule!);
  });
});

describe('the create-task ticket template', () => {
  const template = readFileSync(
    join(import.meta.dir, '../../.agents/skills/create-task/ticket-template.md'),
    'utf8',
  );

  test('has exactly the agreed headings, in order', () => {
    expect([...template.matchAll(/^(#{2,3}) (.+)$/gm)].map((match) => match[0])).toEqual([
      '## Objective',
      '## Context',
      '## Requirements',
      '## Acceptance Criteria',
      '## Scope',
      '### In scope',
      '### Out of scope',
      '## Files',
      '## Constraints',
      '## Verification',
      '## Delivery Boundary',
      '## Open Questions',
    ]);
  });

  test('names the sections the brief extracts, so a filled issue reaches the worker', () => {
    const filled = template
      .replace(/<!--[^]*?-->/g, '')
      .replace(
        '## Acceptance Criteria\n',
        '## Acceptance Criteria\n\n- AC1: the thing is observable.\n',
      )
      .replace('## Files\n', '## Files\n\n- `scripts/chef/thing.ts`\n');
    expect(sectionOf(filled, /acceptance\s+criteria/i)).toBe('- AC1: the thing is observable.');
    const text = renderBrief(issue(filled), { paths: [], verify: [], model: 'Sonnet' });
    expect(text).toContain('## Files\n\n- `scripts/chef/thing.ts`');
  });
});

describe('run', () => {
  const fetchIssue: FetchLike = async () =>
    new Response(JSON.stringify({ data: { issue: issue(description) } }), { status: 200 });
  const dependencies = { fetch: fetchIssue, environment: { LINEAR_API_KEY: 'lin_api_test_value' } };

  test('writes <ID>.md in the output directory and reports it', async () => {
    const result = await run(['COR-7', '--out-dir', sandbox, '--json'], dependencies);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.output) as { path: string };
    expect(parsed.path).toBe(join(sandbox, 'COR-7.md'));
    expect(readFileSync(parsed.path, 'utf8')).toContain('## Charter rules');
  });

  test('reports a missing issue as exit 1 and bad usage as a UsageError', async () => {
    const missing: FetchLike = async () =>
      new Response(JSON.stringify({ data: { issue: null } }), { status: 200 });
    const result = await run(['COR-9', '--out-dir', sandbox], { ...dependencies, fetch: missing });
    expect(result.code).toBe(1);
    expect(result.output).toContain('No issue COR-9');
    expect(await rejectionOf(run([], dependencies))).toBeInstanceOf(UsageError);
    expect(await rejectionOf(run(['not an id'], dependencies))).toBeInstanceOf(UsageError);
  });
});
