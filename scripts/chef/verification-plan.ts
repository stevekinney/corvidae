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
      expectedInventory: input.assignment.ownedPaths,
      relevantInputs: [
        input.assignment.identity.digest,
        ...input.assignment.sourceReferences.map((ref) => ref.digest),
      ],
      environmentToolchain: 'Bun workspace toolchain',
      executionBoundary: 'worker' as const,
      producer: 'scripts/chef/brief.ts',
      selectionReason:
        'Required direct static and documentation verification for the assigned criterion.',
    })),
  );
  for (const risk of activeRisks)
    obligations.push({
      criterionId: obligationCriteria[0] ?? 'STATIC',
      risk,
      commandOrProviderJob: 'bun scripts/chef/focused-checks.ts',
      expectedInventory: input.assignment.ownedPaths,
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
