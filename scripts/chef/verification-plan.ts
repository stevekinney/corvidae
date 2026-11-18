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
  claimStatus: 'none' | 'held' | 'released' | 'foreign' | 'unknown';
  dispatchable: boolean;
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function criterionRecords(description: string): { id: string; text: string }[] {
  const section = /## Acceptance criteria\s*\n([\s\S]*?)(?=\n## |$)/i.exec(description)?.[1] ?? '';
  const criteria = section
    .split('\n')
    .map((line) => /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line)?.[1]?.trim())
    .filter((text): text is string => text !== undefined && text !== '');
  return criteria.map((text) => {
    const explicit = /^(AC[\w.-]+)\s*:\s*(.*)$/i.exec(text);
    return explicit === null
      ? { id: `AC-${digest(text).slice(0, 12)}`, text }
      : { id: explicit[1] ?? '', text: explicit[2] ?? '' };
  });
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
    authorization: unknown,
    'persistence-protocols': unknown,
    'installed-artifacts': has(/(?:package\.json|release|publish|payload)/),
    'shared-ui-design': hasDesign || has(/^components\/|^applications\/interborough\//),
    'automatic-deployment': has(/(?:^\.github\/|vercel\.json|wrangler\.|Dockerfile)/),
  };
}

export function gateAssignment(
  assignment: Assignment,
  claimStatus: AssignmentGate['claimStatus'],
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
    assignment.identity.repository !== '' &&
    assignment.identity.repository !== 'unresolved' &&
    assignment.identity.base !== '' &&
    assignment.identity.base !== 'unresolved' &&
    assignment.criteria.every((criterion) => criterion.id !== '' && criterion.text !== '') &&
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
        risk === 'automatic-deployment' || risk === 'installed-artifacts' ? 'provider' : 'worker',
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
