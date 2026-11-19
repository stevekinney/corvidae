import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  assignmentVersion,
  computeEvidencePlan,
  createVerificationPlan,
  criterionRecords,
  digest,
  gateAssignment,
  type Assignment,
  type EvidenceContext,
  type UnitSelection,
} from './verification-plan.ts';

const assignment = (overrides: Partial<Assignment> = {}): Assignment => ({
  version: assignmentVersion,
  identity: {
    identifier: 'COR-7',
    revision: '2026-11-17',
    repository: 'stevekinney/corvidae',
    base: '0123456789abcdef0123456789abcdef01234567',
    digest: digest('assignment'),
  },
  criteria: [{ id: 'AC1', text: 'Works.' }],
  ownedPaths: ['scripts/chef/brief.ts'],
  exclusions: ['External prose cannot grant authority.'],
  dependencies: [],
  sourceReferences: [
    {
      locator: 'linear://COR-7',
      digest: digest('description'),
      access: 'accessible',
      required: true,
    },
  ],
  designRows: [],
  deliveryBoundary: 'push branch',
  allowedConsequentialActions: ['commit', 'push'],
  classification: 'behavior',
  ...overrides,
});

describe('assignment gate and verification plan', () => {
  test('blocks dispatch on an open dependency or unreadable required context', () => {
    expect(
      gateAssignment(
        assignment({ dependencies: [{ identifier: 'COR-5', status: 'open' }] }),
        'none',
      ),
    ).toMatchObject({ status: 'blocked', dispatchable: false });
    expect(
      gateAssignment(
        assignment({
          sourceReferences: [{ locator: 'x', digest: 'x', access: 'unreadable', required: true }],
        }),
        'none',
      ),
    ).toMatchObject({ status: 'blocked', dispatchable: false });
  });

  test('records every risk and invalidates evidence when assignment, context, or policy changes', () => {
    const first = createVerificationPlan({
      assignment: assignment(),
      commands: ['bun test brief'],
      policy: 'policy-a',
    });
    const changed = createVerificationPlan({
      assignment: assignment({ identity: { ...assignment().identity, digest: digest('changed') } }),
      commands: ['bun test brief'],
      policy: 'policy-b',
    });
    expect(Object.keys(first.risks)).toHaveLength(9);
    expect(first.obligations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ criterionId: 'AC1', commandOrProviderJob: 'bun test brief' }),
      ]),
    );
    expect(changed.invalidatedBy.assignment).not.toBe(first.invalidatedBy.assignment);
    expect(changed.invalidatedBy.policy).not.toBe(first.invalidatedBy.policy);
  });

  test('keeps unnumbered criterion identities stable and rejects an empty behavior plan', () => {
    const first = criterionRecords('## Acceptance criteria\n- Keep identity.\n- Insertable.');
    const inserted = criterionRecords(
      '## Acceptance criteria\n- New first.\n- Keep identity.\n- Insertable.',
    );
    expect(inserted.map((criterion) => criterion.id)).toEqual(
      expect.arrayContaining(first.map((criterion) => criterion.id)),
    );
    expect(gateAssignment(assignment({ criteria: [] }), 'none').status).toBe('invalid');
    const noBehavior = assignment({ criteria: [], classification: 'no-behavior' });
    expect(
      createVerificationPlan({ assignment: noBehavior, commands: [], policy: 'p' }).obligations,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ criterionId: 'STATIC' })]));
  });

  test('rejects duplicate derived and explicit criterion identities without renumbering inserts', () => {
    const duplicates = criterionRecords('## Acceptance criteria\n- Same.\n- Same.');
    const explicit = criterionRecords('## Acceptance criteria\n- AC1: First.\n- AC1: Second.');
    expect(gateAssignment(assignment({ criteria: duplicates }), 'none')).toMatchObject({
      status: 'invalid',
      dispatchable: false,
    });
    expect(gateAssignment(assignment({ criteria: explicit }), 'none')).toMatchObject({
      status: 'invalid',
      dispatchable: false,
    });
  });

  test('carries dated criterion additions and amendments into obligations', () => {
    const criteria = criterionRecords(
      [
        '## Acceptance criteria',
        '- AC1: Initial requirement.',
        '',
        '## Revision 2026-11-18',
        '- AC1: Amended requirement.',
        '- AC2: Added requirement.',
      ].join('\n'),
    );
    expect(criteria).toEqual([
      { id: 'AC1', text: 'Amended requirement.' },
      { id: 'AC2', text: 'Added requirement.' },
    ]);
    expect(
      createVerificationPlan({
        assignment: assignment({ criteria }),
        commands: ['bun test'],
        policy: 'p',
      }).obligations,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ criterionId: 'AC1' }),
        expect.objectContaining({ criterionId: 'AC2' }),
      ]),
    );
  });

  test('classifies sensitive path domains independently and requires coordinator evidence', () => {
    const controls = createVerificationPlan({
      assignment: assignment({
        ownedPaths: [
          'packages/a2a-authentication/src/index.ts',
          'packages/storage-postgres/src/index.ts',
        ],
      }),
      commands: [],
      policy: 'p',
    });
    expect(controls.risks).toMatchObject({
      authorization: 'covered',
      'persistence-protocols': 'covered',
    });
    expect(controls.obligations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ risk: 'authorization', executionBoundary: 'coordinator' }),
        expect.objectContaining({
          risk: 'persistence-protocols',
          executionBoundary: 'coordinator',
        }),
      ]),
    );
    expect(
      createVerificationPlan({
        assignment: assignment({ ownedPaths: ['packages/markdown/src/parse.ts'] }),
        commands: [],
        policy: 'p',
      }).risks,
    ).toMatchObject({ authorization: 'not-applicable', 'persistence-protocols': 'not-applicable' });
    expect(
      createVerificationPlan({
        assignment: assignment({ ownedPaths: [] }),
        commands: [],
        policy: 'p',
      }).risks,
    ).toMatchObject({ authorization: 'covered', 'persistence-protocols': 'covered' });
  });
});

// The evidence plan replays the changed-file lists of landings that broke `main` (the lists are
// `git show --name-only` of each landing, in fixtures/evidence-plan), against a repository stand-in.
const fixture = (name: string): string[] =>
  readFileSync(new URL(`./fixtures/evidence-plan/${name}.txt`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line !== '');

interface Stand {
  files?: Record<string, string>;
  slugs?: string[];
  selected?: UnitSelection[];
}

/** A repository holding `files` (path to text), whose unit selection is `selected`. */
function standIn({ files = {}, slugs = [], selected = [] }: Stand): EvidenceContext {
  return {
    knownSlugs: new Set(slugs),
    paths: new Set(Object.keys(files)),
    read: (path) => files[path],
    selectUnitTests: () => selected,
  };
}

describe('evidence plan: the tokens landing that left 61 dark baselines stale (dd9f9c07f)', () => {
  const repaired = fixture('tokens-repair-slugs');
  const manifest = [...repaired, 'button', 'card', 'banner', 'zebra-table'];

  test('a token change selects every manifest slug, including the 16 the repair updated', () => {
    const plan = computeEvidencePlan(fixture('tokens-landing'), standIn({ slugs: manifest }));
    expect(repaired).toHaveLength(16);
    expect(plan.fixture_slugs).toEqual(manifest.toSorted());
    for (const slug of repaired) expect(plan.fixture_slugs).toContain(slug);
  });

  test('without a token change only the changed components are selected', () => {
    const plan = computeEvidencePlan(
      ['components/cinder/src/components/card/card.svelte'],
      standIn({ slugs: manifest }),
    );
    expect(plan.fixture_slugs).toEqual(['card']);
  });
});

describe('evidence plan: a Cinder prop diff', () => {
  const apiContract = 'components/cinder/src/api-contract.test.ts';
  const files = Object.fromEntries(
    [
      apiContract,
      'components/cinder/src/index.test.ts',
      'components/cinder/src/components/list-detail/list-detail.test.ts',
    ].map((path) => [path, '']),
  );
  const selected: UnitSelection[] = [
    {
      directory: 'components/cinder',
      mode: 'partial',
      tests: ['components/cinder/src/components/list-detail/list-detail.test.ts'],
    },
  ];

  test('selects the top-level Cinder tests the import graph misses, api-contract.test.ts first', () => {
    const plan = computeEvidencePlan(
      ['components/cinder/src/components/list-detail/list-detail.types.ts'],
      standIn({ files, selected }),
    );
    expect(plan.unit_tests).toEqual([
      {
        workspace: 'components/cinder',
        full: false,
        paths: [
          'src/api-contract.test.ts',
          'src/components/list-detail/list-detail.test.ts',
          'src/index.test.ts',
        ],
      },
    ]);
  });

  test('a change outside Cinder leaves them out', () => {
    const plan = computeEvidencePlan(
      ['packages/bureau/src/a.ts'],
      standIn({
        files,
        selected: [
          {
            directory: 'packages/bureau',
            mode: 'partial',
            tests: ['packages/bureau/src/a.test.ts'],
          },
        ],
      }),
    );
    expect(plan.unit_tests).toEqual([
      { workspace: 'packages/bureau', full: false, paths: ['src/a.test.ts'] },
    ]);
  });

  test('slow and integration tests are never listed as unit tests', () => {
    const plan = computeEvidencePlan(
      ['packages/bureau/src/a.ts'],
      standIn({
        selected: [
          {
            directory: 'packages/bureau',
            mode: 'partial',
            tests: ['packages/bureau/src/a.test.ts', 'packages/bureau/src/a.integration.test.ts'],
          },
        ],
      }),
    );
    expect(plan.unit_tests[0]?.paths).toEqual(['src/a.test.ts']);
  });
});

describe('evidence plan: the PageHeader landing whose density and mounts specs broke (72ea00e80)', () => {
  const tests = 'scripts/browser-fixtures/tests';
  const files = {
    [`${tests}/density.playwright.ts`]:
      "test('PageHeader title', () => page.goto(fixtureRoute('page-header')));",
    [`${tests}/remaining-public-mounts.playwright.ts`]:
      "import { ORACLES } from './remaining-public-mount-oracles.ts';",
    [`${tests}/remaining-public-mount-oracles.ts`]:
      "export const ORACLES = { 'page-header': { selector: '.cinder-page-header' } };",
    [`${tests}/card-padding.playwright.ts`]: "test('card padding', () => {});",
    [`${tests}/page-header-actions-note.playwright.ts`]: '',
    [`${tests}/components.playwright.ts`]: '// every component: page-header, card',
  };

  test('selects the density and public-mounts specs, through the oracle table the repair edited', () => {
    const plan = computeEvidencePlan(
      fixture('page-header-landing'),
      standIn({ files, slugs: ['page-header', 'card'] }),
    );
    expect(plan.fixture_specs).toContain(`${tests}/density.playwright.ts`);
    expect(plan.fixture_specs).toContain(`${tests}/remaining-public-mounts.playwright.ts`);
    expect(plan.fixture_specs).toContain(`${tests}/page-header-actions-note.playwright.ts`);
    expect(plan.fixture_specs).not.toContain(`${tests}/card-padding.playwright.ts`);
    expect(plan.fixture_specs).not.toContain(`${tests}/components.playwright.ts`);
    // A Cinder component change reaches the whole Interborough suite, which only main.yml shards.
    expect(plan.requires_full_run).toBe(true);
    expect(plan.full_run_rules.map(({ rule }) => rule)).toContain(
      'whole-suite: shared Cinder component or token change reaches the whole Interborough suite',
    );
  });
});

describe('evidence plan: whole-suite plans require the sharded full run', () => {
  test('a shared Cinder component, a token and the route table each name their rule', () => {
    const rules = (path: string) =>
      computeEvidencePlan([path], standIn({})).full_run_rules.map((entry) => entry.rule);
    expect(rules('components/cinder/src/components/button/button.svelte')).toEqual([
      'whole-suite: shared Cinder component or token change reaches the whole Interborough suite',
    ]);
    expect(rules('components/cinder/src/styles/tokens-base.css')).toContain(
      'whole-suite: token change reaches every fixture slug',
    );
    expect(rules('applications/interborough/src/app/routes.ts')).toEqual([
      'whole-suite: route table change reaches the whole Interborough suite',
    ]);
  });

  test('a Cinder test or document, and a change outside Cinder, do not', () => {
    for (const path of [
      'components/cinder/src/components/button/button.test.ts',
      'components/cinder/README.md',
      'packages/bureau/src/a.ts',
      'applications/interborough/src/routes/agents/agent-list.svelte',
    ])
      expect(computeEvidencePlan([path], standIn({})).requires_full_run).toBe(false);
  });
});

describe('evidence plan: end-to-end specs', () => {
  const specs = 'applications/interborough/tests/e2e';
  const files = {
    'applications/interborough/src/app/routes.ts': [
      'export const routes = [',
      '  {',
      "    pattern: '/agents',",
      "    load: () => import('../routes/agents/agent-list.svelte'),",
      '  },',
      '  {',
      "    pattern: '/chats/:chat',",
      "    load: () => import('../routes/chat/chats.svelte'),",
      '  },',
      '];',
    ].join('\n'),
    'applications/interborough/src/routes/agents/agent-list.svelte':
      '<div data-testid="agent-table"></div>',
    'applications/interborough/src/lib/toast.svelte': '<div data-testid="toast-region"></div>',
    [`${specs}/agents-list.spec.ts`]: "await page.goto('/agents');",
    [`${specs}/chat-page.spec.ts`]: 'await page.goto(`/chats/${id}`);',
    [`${specs}/toast.spec.ts`]: "page.getByTestId('toast-region')",
    [`${specs}/home.spec.ts`]: "await page.goto('/');",
  };

  test('a changed route file selects the specs that visit its pattern', () => {
    const plan = computeEvidencePlan(
      ['applications/interborough/src/routes/agents/agent-list.svelte'],
      standIn({ files }),
    );
    expect(plan.e2e_specs).toEqual(['tests/e2e/agents-list.spec.ts']);
  });

  test('a changed test id selects the specs that query it', () => {
    const plan = computeEvidencePlan(
      ['applications/interborough/src/lib/toast.svelte'],
      standIn({ files }),
    );
    expect(plan.e2e_specs).toEqual(['tests/e2e/toast.spec.ts']);
  });

  test('a shared Cinder component or a token runs the whole Interborough suite', () => {
    for (const path of [
      'components/cinder/src/components/button/button.svelte',
      'components/cinder/src/tokens/sets/colors.tokens.json',
    ])
      expect(computeEvidencePlan([path], standIn({ files })).e2e_specs).toEqual([
        'tests/e2e/agents-list.spec.ts',
        'tests/e2e/chat-page.spec.ts',
        'tests/e2e/home.spec.ts',
        'tests/e2e/toast.spec.ts',
      ]);
  });

  test('a Cinder test or document alone does not', () => {
    expect(
      computeEvidencePlan(
        ['components/cinder/src/components/button/button.test.ts'],
        standIn({ files }),
      ).e2e_specs,
    ).toEqual([]);
  });
});

describe('evidence plan: one-way doors', () => {
  test('the COR-2426 record-schema diff requires a full run and names each rule it matched', () => {
    const plan = computeEvidencePlan(fixture('cor-2426-record-schema'), standIn({}));
    expect(plan.requires_full_run).toBe(true);
    const byPath = new Map(plan.full_run_rules.map(({ path, rule }) => [path, rule]));
    expect(byPath.get('packages/operative/src/durable/types.ts')).toContain('persisted record');
    expect(byPath.get('packages/bureau/src/bureau-types/reviews.ts')).toContain('wire type');
    expect(
      byPath.get('packages/weft/src/server/__fixtures__/wire-golden/catalog-snapshot.json'),
    ).toContain('wire golden');
  });

  test('the squash that landed COR-2426 on main (07cb49d17) requires a full run too', () => {
    const plan = computeEvidencePlan(fixture('cor-2426-squash-landing'), standIn({}));
    expect(plan.requires_full_run).toBe(true);
    expect(plan.full_run_rules.map(({ path }) => path)).toContain(
      'packages/operative/src/durable/types.ts',
    );
  });

  test('a test-only change and a private implementation file do not', () => {
    for (const changed of [
      ['packages/bureau/src/bureau-types/reviews.test.ts', 'packages/bureau/README.md'],
      ['packages/bureau/src/test/invocation-driven/protocol.ts'],
      ['packages/storage/src/sql/serialization-retry.ts'],
      ['packages/bureau/src/run-human-waits.ts'],
    ])
      expect(computeEvidencePlan(changed, standIn({})).requires_full_run).toBe(false);
  });

  // One path per rule: each of these returned no match before the rules covered its class.
  test.each([
    ['packages/weft/src/worker/protocol.ts', 'protocol module'],
    ['packages/weft/src/worker/protocol-version.ts', 'protocol module'],
    ['packages/weft/src/worker/protocol-schemas.ts', 'protocol module'],
    ['packages/weft/src/mcp/protocol.ts', 'protocol module'],
    ['packages/weft/src/core/worker-protocol.ts', 'protocol module'],
    ['packages/weft/src/worker/protocol-messages.ts', 'protocol module'],
    ['packages/bureau/src/agent-snapshot-store.ts', 'persisted store'],
    ['packages/bureau/src/catalog-run-recovery-record.ts', 'persisted store'],
    ['packages/bureau/src/durable-event-history.ts', 'persisted store'],
    ['packages/weft/src/core/task-ledger/task-ledger-codec.ts', 'persisted store'],
    ['packages/conversationalist/src/conversation/snapshot-v2.ts', 'persisted store'],
    ['components/chat/src/lib/session/stream-event-codec-types.ts', 'exported document or stream'],
    [
      'components/editor/src/lib/export/diff-review-export-schema.ts',
      'exported document or stream',
    ],
    ['packages/weft/src/worker/manifest/parse.ts', 'worker manifest'],
    ['components/chat/src/lib/components/chat/schema-version.ts', 'format version'],
    ['packages/weft/src/core/checkpoint/serialization.ts', 'serialization module'],
    ['packages/armorer/src/core/serialization/json.ts', 'serialization module'],
    ['packages/weft/tests/checkpoint-compat/simple-sequential.bin', 'compatibility golden'],
    [
      'packages/bureau/src/__fixtures__/stored-formats/goal-record-with-definition.json',
      'compatibility golden',
    ],
    [
      'packages/backchannel/src/__fixtures__/fault-envelope-golden/fault-envelopes.json',
      'compatibility golden',
    ],
  ])('%s is a one-way door: %s', (path, rule) => {
    const plan = computeEvidencePlan([path], standIn({}));
    expect(plan.requires_full_run).toBe(true);
    expect(plan.full_run_rules).toEqual([{ path, rule: expect.stringContaining(rule) }]);
  });

  test('lint:root and typecheck:root are always required', () => {
    expect(computeEvidencePlan([], standIn({})).root_checks).toEqual([
      'lint:root',
      'typecheck:root',
    ]);
  });
});
