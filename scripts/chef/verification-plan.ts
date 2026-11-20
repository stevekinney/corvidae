import { createHash } from 'node:crypto';

export const assignmentVersion = 1 as const;

export type AccessStatus = 'accessible' | 'not-read' | 'unreadable';
export type GateStatus = 'accepted' | 'blocked' | 'invalid';
export type RiskArea =
  | 'root-scripts'
  | 'shared-configuration'
  | 'transitive-consumers'
  | 'dynamic-entrypoints'
  | 'authorization'
  | 'persistence-protocols'
  | 'installed-artifacts'
  | 'shared-ui-design'
  | 'automatic-deployment';

export interface SourceReference {
  locator: string;
  digest: string;
  access: AccessStatus;
  required: boolean;
}

export interface AssignmentDependency {
  identifier: string;
  status: 'open' | 'completed' | 'unreadable';
  detail?: string;
}

export interface DesignRowMapping {
  rowId: string;
  source: string;
}

export interface Assignment {
  version: typeof assignmentVersion;
  identity: {
    identifier: string;
    revision: string;
    repository: string;
    base: string;
    digest: string;
  };
  criteria: { id: string; text: string }[];
  ownedPaths: string[];
  exclusions: string[];
  dependencies: AssignmentDependency[];
  sourceReferences: SourceReference[];
  designRows: DesignRowMapping[];
  deliveryBoundary: string;
  allowedConsequentialActions: string[];
  classification: 'behavior' | 'no-behavior';
}

export interface VerificationObligation {
  criterionId: string;
  risk: RiskArea | 'static-documentation';
  commandOrProviderJob: string;
  expectedInventory: string[];
  relevantInputs: string[];
  environmentToolchain: string;
  executionBoundary: 'worker' | 'coordinator' | 'provider';
  producer: string;
  selectionReason: string;
  evidenceKind: 'process-exit' | 'test-report';
}

export interface VerificationPlan {
  version: typeof assignmentVersion;
  obligations: VerificationObligation[];
  risks: Record<RiskArea, 'covered' | 'not-applicable' | 'unknown'>;
  invalidatedBy: { assignment: string; context: string; policy: string };
}

export interface ExecutionEvidence {
  version: typeof assignmentVersion;
  assignmentDigest: string;
  command: string;
  cwd: string;
  candidate: string;
  environment: string;
  exitCode: number | null;
  inventory: string[];
  evidencePath: string | null;
}

export interface AssignmentGate {
  status: GateStatus;
  blockers: AssignmentDependency[];
  unreadableDependencies: AssignmentDependency[];
  missingContext: SourceReference[];
  identityErrors: string[];
  claimStatus: 'none' | 'held' | 'released' | 'foreign' | 'unknown';
  dispatchable: boolean;
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function criterionRecords(description: string): { id: string; text: string }[] {
  const sections = [...description.matchAll(/^##\s+([^\n]+)\n([\s\S]*?)(?=^##\s|(?![\s\S]))/gim)]
    .map((match) => ({ heading: match[1] ?? '', body: match[2] ?? '' }))
    .filter((section) => /acceptance\s+criteria|\brevision\b/i.test(section.heading));
  const records: { id: string; text: string; revision: boolean }[] = [];
  for (const section of sections) {
    const revision = /\brevision\b/i.test(section.heading);
    for (const line of section.body.split('\n')) {
      const text = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line)?.[1]?.trim();
      if (text === undefined || text === '') continue;
      const explicit = /^(AC[\w.-]+)\s*:\s*(.*)$/i.exec(text);
      const record =
        explicit === null
          ? { id: `AC-${digest(text).slice(0, 12)}`, text, revision }
          : { id: explicit[1] ?? '', text: explicit[2] ?? '', revision };
      const amended =
        revision && explicit !== null ? records.findIndex(({ id }) => id === record.id) : -1;
      if (amended < 0) records.push(record);
      else records[amended] = record;
    }
  }
  return records.map(({ id, text }) => ({ id, text }));
}

export function classifyRisks(
  paths: readonly string[],
  hasDesign: boolean,
): Record<RiskArea, boolean> {
  const unknown = paths.length === 0;
  const has = (pattern: RegExp) => unknown || paths.some((path) => pattern.test(path));
  return {
    'root-scripts': has(/^scripts\//),
    'shared-configuration': has(/(?:^|\/)(?:package\.json|turbo\.json|.*\.(?:json|ya?ml|toml))$/),
    'transitive-consumers': has(/^packages\/|^components\//),
    'dynamic-entrypoints': has(/^applications\/|(?:^|\/)bin\//),
    authorization: has(
      /(?:^|[/_-])(?:auth(?:entication|orization)?|identity|session|access-control)(?=[/_.-]|$)/i,
    ),
    'persistence-protocols': has(
      /(?:^|[/_-])(?:storage|persistence|protocol|database)(?=[/_.-]|$)/i,
    ),
    'installed-artifacts': has(/(?:package\.json|release|publish|payload)/),
    'shared-ui-design': hasDesign || has(/^components\/|^applications\/interborough\//),
    'automatic-deployment': has(/(?:^\.github\/|vercel\.json|wrangler\.|Dockerfile)/),
  };
}

export function gateAssignment(
  assignment: Assignment,
  claimStatus: AssignmentGate['claimStatus'],
  identityErrors: readonly string[] = [],
): AssignmentGate {
  const blockers = assignment.dependencies.filter((dependency) => dependency.status === 'open');
  const unreadableDependencies = assignment.dependencies.filter(
    (dependency) => dependency.status === 'unreadable',
  );
  const missingContext = assignment.sourceReferences.filter(
    (reference) => reference.required && reference.access === 'unreadable',
  );
  const valid =
    assignment.version === assignmentVersion &&
    assignment.identity.identifier !== '' &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(assignment.identity.repository) &&
    /^[0-9a-f]{40}$/i.test(assignment.identity.base) &&
    assignment.criteria.every((criterion) => criterion.id !== '' && criterion.text !== '') &&
    new Set(assignment.criteria.map((criterion) => criterion.id)).size ===
      assignment.criteria.length &&
    identityErrors.length === 0 &&
    (assignment.criteria.length > 0 || assignment.classification === 'no-behavior');
  const blocked =
    blockers.length > 0 ||
    unreadableDependencies.length > 0 ||
    missingContext.length > 0 ||
    claimStatus === 'foreign';
  return {
    status: valid ? (blocked ? 'blocked' : 'accepted') : 'invalid',
    blockers,
    unreadableDependencies,
    missingContext,
    identityErrors: [...identityErrors],
    claimStatus,
    dispatchable: valid && !blocked,
  };
}

export function createVerificationPlan(input: {
  assignment: Assignment;
  commands: readonly string[];
  policy: string;
}): VerificationPlan {
  const riskMap = classifyRisks(
    input.assignment.ownedPaths,
    input.assignment.designRows.length > 0,
  );
  const activeRisks = (Object.entries(riskMap) as [RiskArea, boolean][])
    .filter(([, active]) => active)
    .map(([risk]) => risk);
  const criterionIds = input.assignment.criteria.map((criterion) => criterion.id);
  const obligationCriteria =
    criterionIds.length === 0 && input.assignment.classification === 'no-behavior'
      ? ['STATIC']
      : criterionIds;
  const checks =
    input.commands.length === 0 ? ['bun scripts/chef/focused-checks.ts'] : input.commands;
  const obligations: VerificationObligation[] = checks.flatMap((command) =>
    obligationCriteria.map((criterionId) => ({
      criterionId,
      risk: 'static-documentation' as const,
      commandOrProviderJob: command,
      expectedInventory: [],
      relevantInputs: [
        input.assignment.identity.digest,
        ...input.assignment.sourceReferences.map((ref) => ref.digest),
      ],
      environmentToolchain: 'Bun workspace toolchain',
      executionBoundary: 'worker' as const,
      producer: 'scripts/chef/brief.ts',
      selectionReason:
        'Required direct static and documentation verification for the assigned criterion.',
      evidenceKind: 'process-exit' as const,
    })),
  );
  for (const risk of activeRisks)
    obligations.push({
      criterionId: obligationCriteria[0] ?? 'STATIC',
      risk,
      commandOrProviderJob: 'bun scripts/chef/focused-checks.ts',
      expectedInventory: [],
      relevantInputs: input.assignment.ownedPaths,
      environmentToolchain: 'Bun workspace toolchain',
      executionBoundary:
        risk === 'automatic-deployment' || risk === 'installed-artifacts'
          ? 'provider'
          : risk === 'authorization' || risk === 'persistence-protocols'
            ? 'coordinator'
            : 'worker',
      producer: 'scripts/chef/brief.ts',
      selectionReason: `Risk map includes ${risk}.`,
      evidenceKind: 'process-exit',
    });
  return {
    version: assignmentVersion,
    obligations,
    risks: Object.fromEntries(
      (Object.entries(riskMap) as [RiskArea, boolean][]).map(([risk, active]) => [
        risk,
        active ? 'covered' : 'not-applicable',
      ]),
    ) as VerificationPlan['risks'],
    invalidatedBy: {
      assignment: input.assignment.identity.digest,
      context: digest(
        input.assignment.sourceReferences.map((reference) => reference.digest).join(','),
      ),
      policy: digest(input.policy),
    },
  };
}

// --- The evidence plan: what a diff must be verified by, computed from the changed files --------
//
// `computeEvidencePlan` is pure. The caller supplies the repository's files and the unit-test
// selection (`scripts/chef/evidence-plan.ts` wires the real ones), so a test replays a landing's
// changed-file list without a repository or a process. A `requires_full_run` plan names the rule and
// the path that set it.

export type UnitSelectionMode = 'partial' | 'full';

/** The test files one workspace must run, as `scripts/affected-tests.ts` selects them. */
export interface UnitSelection {
  /** The workspace folder (`components/cinder`), or '' for the repository root. */
  directory: string;
  mode: UnitSelectionMode;
  /** Repository-relative test paths. */
  tests: readonly string[];
}

export interface EvidenceContext {
  /** The slugs of the fixture manifest. */
  knownSlugs: ReadonlySet<string>;
  /** Every repository path that exists. */
  paths: ReadonlySet<string>;
  /** The text of a repository file, or undefined when it cannot be read. */
  read: (path: string) => string | undefined;
  /** The unit-test selection for the changed paths, with consumers included. */
  selectUnitTests: (changed: readonly string[]) => readonly UnitSelection[];
}

export interface PlannedUnitTests {
  /** The workspace folder, or '' for the repository root. */
  workspace: string;
  /** Workspace-relative test paths. */
  paths: string[];
  /** Whether the workspace's whole suite is selected. */
  full: boolean;
}

export interface FullRunRule {
  rule: string;
  path: string;
}

export interface EvidencePlan {
  changed: string[];
  unit_tests: PlannedUnitTests[];
  root_checks: ['lint:root', 'typecheck:root'];
  /** Every manifest slug on a token change, otherwise the changed components' slugs. */
  fixture_slugs: string[];
  fixture_specs: string[];
  /** Interborough end-to-end specs as `tests/e2e/<name>.spec.ts`. */
  e2e_specs: string[];
  requires_full_run: boolean;
  full_run_rules: FullRunRule[];
}

export const COMPONENT_DIRECTORIES = [
  /^components\/cinder\/src\/components\/([\w-]+)\//,
  /^components\/chat\/src\/lib\/components\/([\w-]+)\//,
  /^scripts\/browser-fixtures\/src\/fixtures\/([\w-]+)\.svelte$/,
];

const CINDER = 'components/cinder/';
const CINDER_SOURCE = 'components/cinder/src/';
const FIXTURE_TESTS = 'scripts/browser-fixtures/tests/';
const E2E_DIRECTORY = 'applications/interborough/tests/e2e/';
const INTERBOROUGH_ROUTES = 'applications/interborough/src/routes/';
const ROUTES_FILE = 'applications/interborough/src/app/routes.ts';
const FIXTURE_SPEC_PATH = /^scripts\/browser-fixtures\/tests\/[\w.-]+\.playwright\.ts$/;
const ISOLATED = /\.(?:slow|integration)\.test\.ts$/;
const TEST_FILE = /\.(?:test|test-support|spec|playwright|bench)\.[cm]?[jt]sx?$/;
const SOURCE_TEST_ID = /data-testid=(?:\{\s*)?["'`]([\w:.-]+)["'`]/g;

const TOKEN_PATH = /^components\/cinder\/src\/(?:tokens\/|styles\/tokens-base\.css$)/;

/** One-way-door paths, per AGENTS.md: persisted formats, wire protocols, published specs. */
export const oneWayDoorRules: readonly { rule: string; pattern: RegExp }[] = [
  {
    rule: 'wire golden: a wire protocol or published-spec snapshot',
    pattern: /(?:^|\/)__fixtures__\/wire-golden\//,
  },
  {
    rule: 'persisted record or checkpoint type: a stored format',
    pattern: /^packages\/[^/]+\/src\/(?:.*\/)?durable\/[^/]*(?:types|version|schema)[^/]*\.ts$/,
  },
  {
    rule: 'persistence layer or migration: a stored format',
    pattern:
      /(?:-persistence\.ts$|(?:^|\/)migrations?\/|^packages\/storage[^/]*\/src\/(?:.*\/)?[^/]*schema[^/]*\.(?:ts|sql)$)/,
  },
  {
    rule: 'protocol module, version or schemas: a versioned wire protocol',
    pattern:
      /^(?:packages|components)\/(?!.*\/tests?\/).*(?:(?:^|[/-])protocol(?:-version|-schemas|-messages|-internals)?|-protocol(?:-[\w]+)?)\.ts$/,
  },
  {
    rule: 'persisted store, ledger, record or codec module: a stored format',
    pattern:
      /^packages\/(?:bureau|memory|operative|weft|conversationalist)\/src\/(?!.*\/tests?\/)(?:.*\/)?(?:[\w-]*(?:-store|-store-core|-record|-ledger|-outbox|-receipts?|-holds|-codec)|durable-event-history|goal-state|snapshot-[\w-]+|history-snapshot|evidence-schema|evidence-projection-schema)\.ts$/,
  },
  {
    rule: 'exported document or stream format: a codec, export schema or its fixtures',
    pattern:
      /^components\/chat\/src\/lib\/session\/stream-event-codec[\w-]*\.ts$|^components\/editor\/src\/lib\/export\/(?:diff-review-export-(?:schema|types|model)\.ts$|__fixtures__\/diff-review\/)/,
  },
  {
    rule: 'worker manifest: the published manifest format a worker declares',
    pattern: /^packages\/weft\/src\/worker\/manifest\/(?!.*\.test)[\w-]+\.ts$/,
  },
  {
    rule: 'format version: a persisted or wire format version',
    pattern:
      /^(?:packages|components)\/(?!.*\/tests?\/).*(?:^|\/)(?:schema|protocol|checkpoint)-version\.ts$/,
  },
  {
    rule: 'serialization module: a persisted or wire encoding',
    pattern:
      /^packages\/(?!.*\/tests?\/).*(?:^|\/)serialization(?!-(?:retry|test-helpers))[\w-]*\.ts$|^packages\/(?!.*\/tests?\/).*\/serialization\/[\w-]+\.ts$/,
  },
  {
    rule: 'compatibility golden: a persisted checkpoint or stored-format fixture',
    pattern:
      /(?:^|\/)(?:checkpoint-compat|__fixtures__\/stored-formats|__fixtures__\/[\w-]*golden[\w-]*)\//,
  },
  {
    rule: 'wire type or protocol definition: a wire protocol',
    pattern:
      /^packages\/(?:bureau\/src\/bureau-types\/|weft\/src\/core\/types\/|armorer\/src\/protocol\/|ventriloquist\/src\/protocol\/|backchannel\/src\/openrpc)|(?:^|\/)workspace-projection-fields\.json$/,
  },
  {
    rule: 'published spec: a schema, OpenAPI, OpenRPC or AsyncAPI document, or the published exports',
    pattern:
      /^packages\/.+\.(?:schema|openapi|openrpc|asyncapi)\.json$|^scripts\/published-exports\.json$/,
  },
];

/** The first one-way-door rule each changed path matches; tests and prose never match. */
export function oneWayDoorMatches(changed: readonly string[]): FullRunRule[] {
  const matches: FullRunRule[] = [];
  for (const path of changed) {
    if (/\.(?:test|test-support)\.[cm]?[jt]sx?$|\.md$/.test(path)) continue;
    const rule = oneWayDoorRules.find(({ pattern }) => pattern.test(path));
    if (rule !== undefined) matches.push({ rule: rule.rule, path });
  }
  return matches;
}

const escapedText = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a spec's file name carries `name` as whole hyphen-separated words. */
export function fileNames(spec: string, name: string): boolean {
  return new RegExp(`(?:^|-)${escapedText(name)}(?:-|\\.)`).test(spec);
}

/** Whether a spec's source names a Cinder component, as `citation` or `Citation`. */
export function sourceNames(source: string, name: string): boolean {
  const pascal = name
    .split('-')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join('');
  return new RegExp(`(?<![\\w-])(?:${escapedText(name)}|${pascal})(?![\\w-])`).test(source);
}

function supportStem(path: string): string {
  return path.slice(FIXTURE_TESTS.length).replace(/\.ts$/, '');
}

function fixtureSpecsFor(names: ReadonlySet<string>, context: EvidenceContext): string[] {
  if (names.size === 0) return [];
  const files = [...context.paths].filter(
    (path) =>
      path.startsWith(FIXTURE_TESTS) &&
      path.endsWith('.ts') &&
      !path.slice(FIXTURE_TESTS.length).includes('/'),
  );
  const named = (path: string): boolean => {
    const file = path.slice(FIXTURE_TESTS.length);
    const source = context.read(path) ?? '';
    return [...names].some((name) => fileNames(file, name) || sourceNames(source, name));
  };
  // A support file (an oracle table, a helper) names a component for every spec importing it.
  const supports = new Set(
    files.filter((path) => !FIXTURE_SPEC_PATH.test(path) && named(path)).map(supportStem),
  );
  const selected = new Set<string>();
  for (const spec of files.filter((path) => FIXTURE_SPEC_PATH.test(path))) {
    if (
      spec.endsWith('/components.playwright.ts') ||
      spec.endsWith('/components-sweep.playwright.ts')
    )
      continue;
    const source = context.read(spec) ?? '';
    const imported = [...source.matchAll(/from\s+['"]\.\/([\w.-]+?)(?:\.ts)?['"]/g)].map(
      (match) => match[1] ?? '',
    );
    if (named(spec) || imported.some((stem) => supports.has(stem))) selected.add(spec);
  }
  return [...selected].toSorted();
}

interface RouteEntry {
  pattern: string;
  directory: string;
}

/** The route table's patterns with the `src/routes` folder each one loads from, when it names one. */
function routeEntries(source: string): RouteEntry[] {
  const entries: RouteEntry[] = [];
  for (const chunk of source.split(/^\s*pattern:\s*/m).slice(1)) {
    const pattern = /^['"`]([^'"`]+)['"`]/.exec(chunk)?.[1];
    if (pattern === undefined) continue;
    const entry = chunk.split(/^\s*\},?$/m)[0] ?? '';
    entries.push({ pattern, directory: /routes\/([\w-]+)\//.exec(entry)?.[1] ?? '' });
  }
  return entries;
}

/** A pattern's literal prefix: `/chats/:chat` is `/chats/`. */
function staticPrefix(pattern: string): string {
  const colon = pattern.indexOf(':');
  return colon < 0 ? pattern : pattern.slice(0, colon);
}

/**
 * The changes whose plan is the whole Interborough suite or every fixture slug. Neither fits a
 * targeted dispatch: `targeted-checks.yml` gives the suite one 30-minute job where `main.yml` runs
 * it as four shards of about 23 minutes, and the all-slug sweep is a 31 to 41 minute shard. Each
 * match names its rule and the first path that matched it.
 */
export function wholeSuiteMatches(changed: readonly string[]): FullRunRule[] {
  const matches: FullRunRule[] = [];
  const shared = changed.find(
    (path) =>
      path.startsWith(CINDER_SOURCE) &&
      !TEST_FILE.test(path) &&
      !path.endsWith('.md') &&
      !path.includes('/documentation/'),
  );
  if (shared !== undefined)
    matches.push({
      rule: 'whole-suite: shared Cinder component or token change reaches the whole Interborough suite',
      path: shared,
    });
  if (changed.includes(ROUTES_FILE))
    matches.push({
      rule: 'whole-suite: route table change reaches the whole Interborough suite',
      path: ROUTES_FILE,
    });
  const token = changed.find((path) => TOKEN_PATH.test(path));
  if (token !== undefined)
    matches.push({
      rule: 'whole-suite: token change reaches every fixture slug',
      path: token,
    });
  return matches;
}

function e2eSpecsFor(changed: readonly string[], context: EvidenceContext): string[] {
  const specs = [...context.paths].filter(
    (path) => path.startsWith(E2E_DIRECTORY) && path.endsWith('.spec.ts'),
  );
  const specPath = (path: string) => path.slice('applications/interborough/'.length);
  // `affected-tests.ts` never reaches Playwright, so a change every page renders runs the suite.
  if (wholeSuiteMatches(changed).some(({ rule }) => rule.includes('Interborough')))
    return specs.map(specPath).toSorted();
  const selected = new Set<string>();
  for (const path of changed) if (specs.includes(path)) selected.add(specPath(path));
  const routesSource = context.read(ROUTES_FILE);
  const directories = new Set(
    changed
      .filter((path) => path.startsWith(INTERBOROUGH_ROUTES))
      .map((path) => path.slice(INTERBOROUGH_ROUTES.length).split('/')[0] ?? ''),
  );
  const prefixes =
    routesSource === undefined
      ? []
      : routeEntries(routesSource)
          .filter((entry) => entry.directory !== '' && directories.has(entry.directory))
          .map((entry) => staticPrefix(entry.pattern));
  const ids = new Set<string>();
  for (const path of changed) {
    if (TEST_FILE.test(path) || !/\.(?:svelte|ts)$/.test(path)) continue;
    if (!path.startsWith('applications/interborough/src/') && !path.startsWith('components/'))
      continue;
    for (const match of (context.read(path) ?? '').matchAll(SOURCE_TEST_ID))
      ids.add(match[1] ?? '');
  }
  for (const spec of specs) {
    const source = context.read(spec) ?? '';
    const route = prefixes.some((prefix) =>
      prefix === '/'
        ? /['"`]\/['"`]/.test(source)
        : new RegExp(`['"\`]${escapedText(prefix.replace(/\/$/, ''))}`).test(source),
    );
    const id = [...ids].some((value) =>
      new RegExp(`['"\`]${escapedText(value)}['"\`]`).test(source),
    );
    if (route || id) selected.add(specPath(spec));
  }
  return [...selected].toSorted();
}

function unitTestsFor(changed: readonly string[], context: EvidenceContext): PlannedUnitTests[] {
  const byWorkspace = new Map<string, { paths: Set<string>; full: boolean }>();
  const lane = (directory: string) => {
    const existing = byWorkspace.get(directory);
    if (existing !== undefined) return existing;
    const created = { paths: new Set<string>(), full: false };
    byWorkspace.set(directory, created);
    return created;
  };
  const strip = (directory: string, path: string) =>
    directory === '' ? path : path.slice(directory.length + 1);
  for (const selection of context.selectUnitTests(changed)) {
    const target = lane(selection.directory);
    if (selection.mode === 'full') target.full = true;
    for (const test of selection.tests)
      if (!ISOLATED.test(test)) target.paths.add(strip(selection.directory, test));
  }
  // The import graph misses `api-contract.test.ts`, which reads component files by a computed path.
  if (changed.some((path) => path.startsWith(CINDER))) {
    const target = lane('components/cinder');
    for (const path of context.paths)
      if (/^components\/cinder\/src\/[^/]+\.test\.ts$/.test(path) && !ISOLATED.test(path))
        target.paths.add(strip('components/cinder', path));
  }
  return [...byWorkspace]
    .filter(([, { paths, full }]) => paths.size > 0 || full)
    .map(([workspace, { paths, full }]) => ({ workspace, paths: [...paths].toSorted(), full }))
    .toSorted((a, b) => a.workspace.localeCompare(b.workspace));
}

/** The evidence a diff requires, computed from its changed files. Pure. */
export function computeEvidencePlan(
  changed: readonly string[],
  context: EvidenceContext,
): EvidencePlan {
  const direct = new Set<string>();
  const names = new Set<string>();
  for (const path of changed)
    for (const pattern of COMPONENT_DIRECTORIES) {
      const slug = pattern.exec(path)?.[1];
      if (slug === undefined) continue;
      names.add(slug);
      if (context.knownSlugs.has(slug)) direct.add(slug);
    }
  const tokenChange = changed.some((path) => TOKEN_PATH.test(path));
  const fixtureSpecs = new Set(fixtureSpecsFor(names, context));
  for (const path of changed) if (FIXTURE_SPEC_PATH.test(path)) fixtureSpecs.add(path);
  const matches = [...oneWayDoorMatches(changed), ...wholeSuiteMatches(changed)];
  return {
    changed: [...changed],
    unit_tests: unitTestsFor(changed, context),
    root_checks: ['lint:root', 'typecheck:root'],
    fixture_slugs: (tokenChange ? [...context.knownSlugs] : [...direct]).toSorted(),
    fixture_specs: [...fixtureSpecs].toSorted(),
    e2e_specs: e2eSpecsFor(changed, context),
    requires_full_run: matches.length > 0,
    full_run_rules: matches,
  };
}
