import schema from './evidence.schema.json';

export type EvidenceCell = {
  id: string;
  passed: boolean;
  observations: string[];
  versions: Record<string, string>;
  metrics: Record<string, { value: number; unit: string }>;
  workload?: WorkloadDefinition;
};

export type WorkloadDefinition = {
  fixture: string;
  durationMilliseconds: number;
  samples: number;
  warmup: number;
  hardware: string;
  runtime: string;
  browser?: string;
  engine?: string;
  method: string;
  unit: string;
  comparator: string;
  target: string;
  control: string;
  rawObservations: string[];
};

export type EvidenceReport = {
  schemaVersion: 1;
  reportKind: 'runtime' | 'engine' | 'resource';
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
  status: 'ready' | 'unavailable';
};

type SelectedEngine = { name: string; version: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEvidenceCell(value: unknown): value is EvidenceCell {
  if (!isRecord(value)) return false;
  const versions = value['versions'];
  const metrics = value['metrics'];
  return (
    typeof value['id'] === 'string' &&
    value['id'].length > 0 &&
    typeof value['passed'] === 'boolean' &&
    Array.isArray(value['observations']) &&
    value['observations'].every((item) => typeof item === 'string') &&
    isRecord(versions) &&
    Object.values(versions).every((version) => typeof version === 'string' && version.length > 0) &&
    isRecord(metrics) &&
    Object.values(metrics).every(
      (metric) =>
        isRecord(metric) &&
        typeof metric['value'] === 'number' &&
        typeof metric['unit'] === 'string' &&
        metric['unit'].length > 0 &&
        Object.keys(metric).every((key) => key === 'value' || key === 'unit'),
    )
  );
}

function isWorkloadDefinition(value: unknown): value is WorkloadDefinition {
  if (!isRecord(value)) return false;
  const requiredStrings = [
    'fixture',
    'hardware',
    'runtime',
    'method',
    'unit',
    'comparator',
    'target',
    'control',
  ];
  return (
    requiredStrings.every((key) => typeof value[key] === 'string' && value[key].length > 0) &&
    typeof value['durationMilliseconds'] === 'number' &&
    Number.isFinite(value['durationMilliseconds']) &&
    typeof value['samples'] === 'number' &&
    Number.isInteger(value['samples']) &&
    value['samples'] > 0 &&
    typeof value['warmup'] === 'number' &&
    Number.isInteger(value['warmup']) &&
    value['warmup'] >= 0 &&
    (value['browser'] === undefined || typeof value['browser'] === 'string') &&
    (value['engine'] === undefined || typeof value['engine'] === 'string') &&
    Array.isArray(value['rawObservations']) &&
    value['rawObservations'].length > 0 &&
    value['rawObservations'].every((item) => typeof item === 'string')
  );
}

function isCandidateEvidence(value: unknown): value is CandidateEvidence {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    value['name'].length > 0 &&
    typeof value['version'] === 'string' &&
    value['version'].length > 0 &&
    typeof value['passed'] === 'boolean' &&
    (value['status'] === 'ready' || value['status'] === 'unavailable') &&
    Array.isArray(value['cells']) &&
    value['cells'].length > 0 &&
    value['cells'].every(isEvidenceCell)
  );
}

function isSelectedEngine(value: unknown): value is SelectedEngine {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    value['name'].length > 0 &&
    typeof value['version'] === 'string' &&
    value['version'].length > 0 &&
    Object.keys(value).every((key) => key === 'name' || key === 'version')
  );
}

function validateCandidates(
  value: Record<string, unknown>,
  expectedCellIds: string[],
  topLevelCells: unknown[],
  errors: string[],
): void {
  if (value['reportKind'] !== 'engine' || value['selectedEngine'] === undefined) return;
  const candidates = value['candidates'];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    errors.push('selected engine candidates');
    return;
  }
  const names = new Set<string>();
  for (const candidate of candidates) {
    if (!isCandidateEvidence(candidate)) {
      errors.push('candidate shape');
      continue;
    }
    if (names.has(candidate.name)) errors.push('duplicate candidate');
    names.add(candidate.name);
    const ids = candidate.cells.map((cell) => cell['id']);
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
    const topLevel = new Map(
      topLevelCells.filter(isEvidenceCell).map((cell) => [cell['id'], cell] as const),
    );
    for (const cell of candidate.cells) {
      const corresponding = topLevel.get(`${candidate.name}:${cell['id']}`);
      if (!corresponding || corresponding['passed'] !== cell['passed'])
        errors.push('candidate cell disagreement');
    }
    if (candidate.status !== 'ready' && candidate.status !== 'unavailable')
      errors.push('candidate status');
  }
  const selectedEngine = value['selectedEngine'];
  if (selectedEngine === null) {
    if (value['passed'] === true) errors.push('selected engine required');
    return;
  }
  if (!isSelectedEngine(selectedEngine)) {
    errors.push('selected engine shape');
    return;
  }
  const selected = candidates.find(
    (candidate): candidate is CandidateEvidence =>
      isCandidateEvidence(candidate) &&
      candidate.name === selectedEngine.name &&
      candidate.version === selectedEngine.version,
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
  if (!isRecord(report)) return ['report object'];
  if (
    !Object.keys(report).every((key) =>
      [
        'schemaVersion',
        'reportKind',
        'sourceSha',
        'runId',
        'observedAt',
        'expectedCellIds',
        'cells',
        'candidates',
        'selectedEngine',
        'passed',
      ].includes(key),
    )
  )
    errors.push('schema constraints');
  const value = report;
  if (value['schemaVersion'] !== 1) errors.push('schemaVersion');
  if (value['reportKind'] !== expectedKind) errors.push('reportKind');
  for (const field of ['sourceSha', 'runId'] as const)
    if (typeof value[field] !== 'string' || value[field].length === 0) errors.push(field);
  if (typeof value['sourceSha'] !== 'string' || value['sourceSha'].length < 7)
    errors.push('schema constraints');
  if (
    typeof value['observedAt'] !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value['observedAt'],
    ) ||
    Number.isNaN(Date.parse(value['observedAt']))
  )
    errors.push('schema constraints');
  const expectedCellIds = value['expectedCellIds'];
  if (
    !Array.isArray(expectedCellIds) ||
    expectedCellIds.length === 0 ||
    expectedCellIds.some((id) => typeof id !== 'string' || id.length === 0) ||
    new Set(expectedCellIds).size !== expectedCellIds.length
  )
    errors.push('expectedCellIds');
  const cells = value['cells'];
  if (!Array.isArray(cells)) return [...errors, 'cells'];
  if (cells.length === 0) errors.push('schema constraints');
  const expectedIds = Array.isArray(expectedCellIds) ? expectedCellIds : [];
  const expected = new Set(expectedIds.filter((id): id is string => typeof id === 'string'));
  const actual = cells.map((cell) => (isRecord(cell) ? cell['id'] : undefined));
  if (actual.some((id) => typeof id !== 'string' || !expected.has(id)))
    errors.push('unexpected cell');
  if (new Set(actual).size !== actual.length) errors.push('duplicate cell');
  if (actual.length !== expected.size || [...expected].some((id) => !actual.includes(id)))
    errors.push('missing cell');
  for (const cell of cells) {
    const cellRecord = isRecord(cell) ? cell : undefined;
    if (
      cellRecord &&
      !Object.keys(cellRecord).every((key) =>
        ['id', 'passed', 'observations', 'versions', 'metrics', 'workload'].includes(key),
      )
    )
      errors.push('schema constraints');
    if (
      !cellRecord ||
      typeof cellRecord['id'] !== 'string' ||
      typeof cellRecord['passed'] !== 'boolean' ||
      !Array.isArray(cellRecord['observations'])
    )
      errors.push('cell shape');
    if (
      !cellRecord ||
      !isRecord(cellRecord['versions']) ||
      Object.keys(cellRecord['versions']).length === 0 ||
      Object.values(cellRecord['versions']).some(
        (version) => typeof version !== 'string' || version.length === 0,
      )
    )
      errors.push('cell versions');
    if (
      !cellRecord ||
      !isRecord(cellRecord['metrics']) ||
      Object.keys(cellRecord['metrics']).length === 0 ||
      Object.values(cellRecord['metrics']).some(
        (metric) =>
          !isRecord(metric) ||
          typeof metric['value'] !== 'number' ||
          typeof metric['unit'] !== 'string' ||
          metric['unit'].length === 0,
      )
    )
      errors.push('cell metrics');
    if (
      Array.isArray(cellRecord?.['observations']) &&
      cellRecord['observations'].some((item) => typeof item !== 'string')
    )
      errors.push('cell observations');
    if (
      cellRecord &&
      isRecord(cellRecord['metrics']) &&
      Object.values(cellRecord['metrics']).some(
        (metric) =>
          !isRecord(metric) ||
          typeof metric['value'] !== 'number' ||
          !Number.isFinite(metric['value']) ||
          typeof metric['unit'] !== 'string' ||
          metric['unit'].trim().length === 0 ||
          !Object.keys(metric).every((key) => key === 'value' || key === 'unit'),
      )
    )
      errors.push('metric value or unit');
    if (expectedKind === 'resource' && !isWorkloadDefinition(cellRecord?.['workload']))
      errors.push('workload definition');
    if (
      cellRecord &&
      isRecord(cellRecord['versions']) &&
      Object.values(cellRecord['versions']).some(
        (version) =>
          typeof version !== 'string' || version === 'unknown' || version.trim().length === 0,
      )
    )
      errors.push('version value');
  }
  if (typeof value['passed'] !== 'boolean') errors.push('passed type');
  if (
    expectedKind === 'runtime' &&
    cells.some(
      (cell) =>
        !isRecord(cell) || !isRecord(cell['versions']) || cell['versions']['bun'] !== '1.4.2',
    )
  )
    errors.push('runtime bun version');
  const candidates = value['candidates'];
  const selectedEngine = value['selectedEngine'];
  const observedPass =
    expectedKind === 'engine'
      ? Array.isArray(candidates) &&
        candidates.every(
          (candidate) => isCandidateEvidence(candidate) && candidate.status === 'ready',
        ) &&
        selectedEngine !== null &&
        selectedEngine !== undefined
      : cells.every((cell) => isRecord(cell) && cell['passed'] === true);
  if (value['passed'] !== observedPass) errors.push('passed consistency');
  validateCandidates(
    value,
    expectedIds.filter((id): id is string => typeof id === 'string'),
    cells,
    errors,
  );
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
