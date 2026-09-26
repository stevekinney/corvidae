import schema from './evidence.schema.json';

export type EvidenceCell = {
  id: string;
  passed: boolean;
  observations: string[];
  versions: Record<string, string>;
  metrics: Record<string, { value: number; unit: string }>;
};

export type EvidenceReport = {
  schemaVersion: 1;
  reportKind: 'runtime' | 'engine';
  sourceSha: string;
  runId: string;
  observedAt: string;
  expectedCellIds: string[];
  cells: EvidenceCell[];
  passed: boolean;
  candidates?: unknown[];
  selectedEngine?: unknown;
};

type CandidateEvidence = {
  name: string;
  version: string;
  passed: boolean;
  cells: EvidenceCell[];
  status?: string;
};

type SelectedEngine = { name: string; version: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCandidateEvidence(value: unknown): value is CandidateEvidence {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.version === 'string' &&
    value.version.length > 0 &&
    typeof value.passed === 'boolean' &&
    Array.isArray(value.cells)
  );
}

function isSelectedEngine(value: unknown): value is SelectedEngine {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.version === 'string' &&
    value.version.length > 0 &&
    Object.keys(value).every((key) => key === 'name' || key === 'version')
  );
}

function validateCandidates(
  value: Record<string, unknown>,
  expectedCellIds: string[],
  errors: string[],
): void {
  if (value.reportKind !== 'engine' || value.selectedEngine === undefined) return;
  if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
    errors.push('selected engine candidates');
    return;
  }
  const names = new Set<string>();
  for (const candidate of value.candidates) {
    if (!isCandidateEvidence(candidate)) {
      errors.push('candidate shape');
      continue;
    }
    if (names.has(candidate.name)) errors.push('duplicate candidate');
    names.add(candidate.name);
    const ids = candidate.cells.map((cell) => cell?.id);
    if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length)
      errors.push('candidate cells');
    const qualifiedIds = new Set(
      expectedCellIds.filter((id) => id.startsWith(`${candidate.name}:`)),
    );
    if (
      qualifiedIds.size === 0 ||
      ids.some((id) => typeof id !== 'string' || !qualifiedIds.has(`${candidate.name}:${id}`)) ||
      ids.length !== qualifiedIds.size
    )
      errors.push('candidate cell completeness');
    if (candidate.passed !== candidate.cells.every((cell) => cell.passed))
      errors.push('candidate passed consistency');
    if (
      candidate.status !== undefined &&
      candidate.status !== 'ready' &&
      candidate.status !== 'unavailable'
    )
      errors.push('candidate status');
  }
  if (value.selectedEngine === null) {
    if (value.passed) errors.push('selected engine required');
    return;
  }
  if (!isSelectedEngine(value.selectedEngine)) {
    errors.push('selected engine shape');
    return;
  }
  const selected = value.candidates.find(
    (candidate): candidate is CandidateEvidence =>
      isCandidateEvidence(candidate) &&
      candidate.name === value.selectedEngine.name &&
      candidate.version === value.selectedEngine.version,
  );
  if (!selected) errors.push('selected engine candidate');
  else if (!selected.passed) errors.push('selected engine failed');
}

export function validateEvidence(
  report: unknown,
  expectedKind: EvidenceReport['reportKind'],
): string[] {
  const errors: string[] = [];
  if (schema['$schema'] !== 'https://json-schema.org/draft/2020-12/schema')
    errors.push('schema metadata');
  if (!report || typeof report !== 'object' || Array.isArray(report)) return ['report object'];
  const value: Partial<EvidenceReport> = report;
  if (value.schemaVersion !== 1) errors.push('schemaVersion');
  if (value.reportKind !== expectedKind) errors.push('reportKind');
  for (const field of ['sourceSha', 'runId', 'observedAt'] as const)
    if (typeof value[field] !== 'string' || value[field]?.length === 0) errors.push(field);
  if (
    !Array.isArray(value.expectedCellIds) ||
    value.expectedCellIds.length === 0 ||
    new Set(value.expectedCellIds).size !== value.expectedCellIds.length
  )
    errors.push('expectedCellIds');
  if (!Array.isArray(value.cells)) return [...errors, 'cells'];
  const expected = new Set(value.expectedCellIds ?? []);
  const actual = value.cells.map((cell) => cell?.id);
  if (actual.some((id) => typeof id !== 'string' || !expected.has(id)))
    errors.push('unexpected cell');
  if (new Set(actual).size !== actual.length) errors.push('duplicate cell');
  if (actual.length !== expected.size || [...expected].some((id) => !actual.includes(id)))
    errors.push('missing cell');
  for (const cell of value.cells) {
    if (
      !cell ||
      typeof cell !== 'object' ||
      typeof cell.id !== 'string' ||
      typeof cell.passed !== 'boolean' ||
      !Array.isArray(cell.observations)
    )
      errors.push('cell shape');
    if (
      !cell?.versions ||
      typeof cell.versions !== 'object' ||
      Object.keys(cell.versions).length === 0 ||
      Object.values(cell.versions).some(
        (version) => typeof version !== 'string' || version.length === 0,
      )
    )
      errors.push('cell versions');
    if (
      !cell?.metrics ||
      typeof cell.metrics !== 'object' ||
      Object.keys(cell.metrics).length === 0 ||
      Object.values(cell.metrics).some(
        (metric) =>
          !metric ||
          typeof metric !== 'object' ||
          typeof metric.value !== 'number' ||
          typeof metric.unit !== 'string' ||
          metric.unit.length === 0,
      )
    )
      errors.push('cell metrics');
    if (
      Array.isArray(cell?.observations) &&
      cell.observations.some((item) => typeof item !== 'string')
    )
      errors.push('cell observations');
    if (
      cell?.metrics &&
      typeof cell.metrics === 'object' &&
      Object.values(cell.metrics).some(
        (metric) =>
          !metric ||
          typeof metric.value !== 'number' ||
          !Number.isFinite(metric.value) ||
          typeof metric.unit !== 'string' ||
          metric.unit.trim().length === 0,
      )
    )
      errors.push('metric value or unit');
    if (
      cell?.versions &&
      typeof cell.versions === 'object' &&
      Object.values(cell.versions).some(
        (version) =>
          typeof version !== 'string' || version === 'unknown' || version.trim().length === 0,
      )
    )
      errors.push('version value');
  }
  if (typeof value.passed !== 'boolean') errors.push('passed type');
  const observedPass =
    expectedKind === 'engine'
      ? Array.isArray(value.candidates) &&
        value.candidates.every(
          (candidate) => isCandidateEvidence(candidate) && candidate.status !== 'unavailable',
        ) &&
        value.selectedEngine !== null &&
        value.selectedEngine !== undefined
      : value.cells.every((cell) => cell.passed);
  if (value.passed !== observedPass) errors.push('passed consistency');
  validateCandidates(value, value.expectedCellIds ?? [], errors);
  return errors;
}

export function assertEvidence(
  report: EvidenceReport,
  expectedKind: EvidenceReport['reportKind'],
): void {
  const errors = validateEvidence(report, expectedKind);
  if (errors.length > 0)
    throw new Error(`invalid ${expectedKind} evidence: ${[...new Set(errors)].join(', ')}`);
}
