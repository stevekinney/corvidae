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

export function validateEvidence(
  report: unknown,
  expectedKind: EvidenceReport['reportKind'],
): string[] {
  const errors: string[] = [];
  if (schema['$schema'] !== 'https://json-schema.org/draft/2020-12/schema')
    errors.push('schema metadata');
  if (!report || typeof report !== 'object' || Array.isArray(report)) return ['report object'];
  const value = report as Partial<EvidenceReport>;
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
  }
  if (typeof value.passed !== 'boolean') errors.push('passed type');
  const observedPass =
    expectedKind === 'engine'
      ? value.selectedEngine !== null && value.selectedEngine !== undefined
      : value.cells.every((cell) => cell.passed);
  if (value.passed !== observedPass) errors.push('passed consistency');
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
