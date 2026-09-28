import { validateBrowserAssetEvidence } from './browser-asset-evidence.ts';
import schema from './evidence.schema.json';

export type EvidenceCell = {
  id: string;
  passed: boolean;
  observations: string[];
  versions: Record<string, string>;
  metrics: Record<string, { value: number; unit: string }>;
  workload?: WorkloadDefinition;
};

export type ObservedWorkload = {
  durationMilliseconds: number;
  sampleCount: number;
  warmupCount: number;
  metrics: Record<string, { value: number; unit: string }>;
  raw: Record<string, unknown>;
};

export type WorkloadDefinition = {
  fixtureId: string;
  environment: {
    hardware: string;
    runtime: string;
    browser?: string;
    engine?: string;
  };
  plan: {
    durationMilliseconds: number;
    sampleCount: number;
    warmupCount: number;
    method: string;
    target: { metric: string; unit: string; comparator: 'gte' | 'lte' | 'eq'; value: number };
  };
  control: { passed: true; observed: ObservedWorkload };
  observed: ObservedWorkload;
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
  const environment = value['environment'];
  const plan = value['plan'];
  const target = isRecord(plan) ? plan['target'] : undefined;
  const observed = value['observed'];
  const control = value['control'];
  const validObserved = (candidate: unknown): candidate is ObservedWorkload => {
    if (!isRecord(candidate)) return false;
    const metrics = candidate['metrics'];
    return (
      typeof candidate['durationMilliseconds'] === 'number' &&
      Number.isFinite(candidate['durationMilliseconds']) &&
      candidate['durationMilliseconds'] > 0 &&
      typeof candidate['sampleCount'] === 'number' &&
      Number.isInteger(candidate['sampleCount']) &&
      candidate['sampleCount'] > 0 &&
      typeof candidate['warmupCount'] === 'number' &&
      Number.isInteger(candidate['warmupCount']) &&
      candidate['warmupCount'] >= 0 &&
      isRecord(metrics) &&
      Object.keys(metrics).length > 0 &&
      Object.values(metrics).every(
        (metric) =>
          isRecord(metric) &&
          typeof metric['value'] === 'number' &&
          Number.isFinite(metric['value']) &&
          typeof metric['unit'] === 'string' &&
          metric['unit'].length > 0,
      ) &&
      isRecord(candidate['raw'])
    );
  };
  return (
    typeof value['fixtureId'] === 'string' &&
    value['fixtureId'].length > 0 &&
    isRecord(environment) &&
    typeof environment['hardware'] === 'string' &&
    typeof environment['runtime'] === 'string' &&
    isRecord(plan) &&
    typeof plan['durationMilliseconds'] === 'number' &&
    Number.isFinite(plan['durationMilliseconds']) &&
    typeof plan['sampleCount'] === 'number' &&
    Number.isInteger(plan['sampleCount']) &&
    typeof plan['warmupCount'] === 'number' &&
    Number.isInteger(plan['warmupCount']) &&
    typeof plan['method'] === 'string' &&
    isRecord(target) &&
    typeof target['metric'] === 'string' &&
    typeof target['unit'] === 'string' &&
    ['gte', 'lte', 'eq'].includes(String(target['comparator'])) &&
    typeof target['value'] === 'number' &&
    validObserved(observed) &&
    isRecord(control) &&
    control['passed'] === true &&
    validObserved(control['observed'])
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

function validateResourceCells(cells: unknown[], errors: string[]): void {
  const sameObservation = (left: ObservedWorkload, right: ObservedWorkload): boolean =>
    JSON.stringify(left) === JSON.stringify(right);
  const percentile = (values: number[], fraction: number): number => {
    const ordered = values.toSorted((a, b) => a - b);
    return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? NaN;
  };
  const finiteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  const validControl = (workload: WorkloadDefinition, validationErrors: string[]): void => {
    const control = workload.control.observed;
    if (sameObservation(control, workload.observed))
      validationErrors.push('control observation identical');
    if (
      control.sampleCount !== workload.plan.sampleCount ||
      control.warmupCount !== workload.plan.warmupCount
    )
      validationErrors.push('control sample plan mismatch');
    const targetMetric = control.metrics[workload.plan.target.metric];
    if (
      !targetMetric ||
      targetMetric.unit !== workload.plan.target.unit ||
      !finiteNumber(targetMetric.value)
    )
      validationErrors.push('control metric');
    else {
      const passes =
        workload.plan.target.comparator === 'gte'
          ? targetMetric.value >= workload.plan.target.value
          : workload.plan.target.comparator === 'lte'
            ? targetMetric.value <= workload.plan.target.value
            : targetMetric.value === workload.plan.target.value;
      if (!passes) validationErrors.push('control comparator failed');
    }
    const controlErrors: string[] = [];
    validateRaw(workload, controlErrors, control);
    validationErrors.push(...controlErrors.map((error) => `control:${error}`));
  };
  const validateRaw = (
    workload: WorkloadDefinition,
    validationErrors: string[],
    observation = workload.observed,
  ): void => {
    const raw = observation.raw;
    const metric = (name: string): number | undefined => observation.metrics[name]?.value;
    switch (workload.fixtureId) {
      case 'throughput-and-queues': {
        const bytes = raw['bytes'];
        const duration = raw['duration'];
        const queuePeak = raw['queuePeak'];
        if (
          !finiteNumber(bytes) ||
          bytes <= 0 ||
          !finiteNumber(duration) ||
          duration <= 0 ||
          !finiteNumber(queuePeak) ||
          queuePeak < 0 ||
          metric('throughput') !== bytes / (duration / 1_000) ||
          metric('queuePeak') !== queuePeak ||
          observation.durationMilliseconds !== duration
        )
          validationErrors.push('throughput raw evidence');
        break;
      }
      case 'input-latency': {
        const samples = raw['samples'];
        if (
          !Array.isArray(samples) ||
          samples.length !== workload.plan.sampleCount ||
          samples.some((value) => !finiteNumber(value) || value < 0) ||
          metric('p50') !== percentile(samples, 0.5) ||
          metric('p95') !== percentile(samples, 0.95) ||
          metric('p99') !== percentile(samples, 0.99)
        )
          validationErrors.push('latency raw evidence');
        break;
      }
      case 'memory-plateau': {
        const before = raw['before'];
        const after = raw['after'];
        const delta = raw['delta'];
        if (
          !finiteNumber(before) ||
          !finiteNumber(after) ||
          !finiteNumber(delta) ||
          after < before ||
          delta !== Math.max(0, after - before) / (1024 * 1024) ||
          observation.warmupCount !== workload.plan.warmupCount
        )
          validationErrors.push('memory raw evidence');
        break;
      }
      case 'overflow':
        if (
          raw['attempted'] !== 257 ||
          raw['result'] !== 'input-overflow' ||
          metric('capacity') !== 256 ||
          raw['finalQueueSize'] !== 256 ||
          !finiteNumber(raw['duration']) ||
          raw['duration'] !== observation.durationMilliseconds
        )
          validationErrors.push('overflow raw evidence');
        break;
      case 'cleanup-order':
      case 'teardown': {
        const cleanup = raw['cleanup'];
        const expectedFacts = [
          'authorityRevoked',
          'controlCapacityReserved',
          'userQueueCanceled',
          'processGroupSignaled',
          'parentExited',
          'descendantObservedGone',
          'handlesClosed',
        ];
        const expectedEvents = [
          'authority-revoked',
          'control-reserved-and-queue-canceled',
          'process-group-signaled',
          'handles-closed-and-descendant-observed',
        ];
        const facts =
          isRecord(cleanup) && isRecord(cleanup['facts']) ? cleanup['facts'] : undefined;
        const allTrue = facts ? Object.values(facts).every((value) => value === true) : false;
        const unknown = facts ? facts['descendantObservedGone'] === undefined : false;
        const expectedState = unknown ? 'unknown' : allTrue ? 'complete' : 'incomplete';
        if (
          !isRecord(cleanup) ||
          (cleanup['state'] !== 'complete' &&
            cleanup['state'] !== 'incomplete' &&
            cleanup['state'] !== 'unknown') ||
          typeof cleanup['quarantined'] !== 'boolean' ||
          !isRecord(cleanup['facts']) ||
          JSON.stringify(Object.keys(cleanup['facts'])) !== JSON.stringify(expectedFacts) ||
          JSON.stringify(raw['events']) !== JSON.stringify(expectedEvents) ||
          cleanup['state'] !== expectedState ||
          cleanup['quarantined'] !== !allTrue
        )
          validationErrors.push('cleanup raw evidence');
        break;
      }
      case 'xterm-initialization':
        if (raw['browser'] !== 'Chromium' || raw['passed'] !== true || metric('assertion') !== 1)
          validationErrors.push(`browser assertion evidence:${workload.fixtureId}`);
        break;
      case 'retained-projection-memory':
        if (
          raw['browser'] !== 'Chromium' ||
          raw['passed'] !== true ||
          raw['retained'] !== true ||
          metric('assertion') !== 1
        )
          validationErrors.push(`browser assertion evidence:${workload.fixtureId}`);
        break;
      case 'browser-assets-and-csp':
        if (
          !isRecord(raw['assetEvidence']) ||
          !validateBrowserAssetEvidence(raw['assetEvidence'] as never) ||
          raw['passed'] !== true
        )
          validationErrors.push('browser asset evidence');
        break;
      case 'hidden-page-liveness':
        if (
          raw['cdpState'] !== 'frozen' ||
          (raw['timer'] !== 'ran' && raw['timer'] !== 'suspended') ||
          raw['assertion'] !== (raw['timer'] === 'ran') ||
          raw['duration'] !== observation.durationMilliseconds ||
          metric('liveness') !== (raw['timer'] === 'ran' ? 1 : 0)
        )
          validationErrors.push('hidden liveness evidence');
        break;
      default:
        break;
    }
  };
  for (const item of cells) {
    if (!isRecord(item) || !isWorkloadDefinition(item['workload'])) continue;
    const workload = item['workload'];
    const observed = workload.observed;
    const plan = workload.plan;
    const target = plan.target;
    if (item['id'] !== workload.fixtureId) errors.push('workload fixture mismatch');
    if (JSON.stringify(item['metrics']) !== JSON.stringify(observed.metrics))
      errors.push('observed metrics mismatch');
    if (observed.sampleCount !== plan.sampleCount) errors.push('observed sample count mismatch');
    if (observed.warmupCount !== plan.warmupCount) errors.push('observed warmup count mismatch');
    if (!Object.hasOwn(observed.metrics, target.metric)) errors.push('target metric missing');
    else {
      const metric = observed.metrics[target.metric];
      if (!metric) {
        errors.push('target metric missing');
        continue;
      }
      if (metric.unit !== target.unit) errors.push('target unit mismatch');
      const passes =
        target.comparator === 'gte'
          ? metric.value >= target.value
          : target.comparator === 'lte'
            ? metric.value <= target.value
            : metric.value === target.value;
      if (!passes) errors.push('target comparator failed');
    }
    if (!workload.control.passed || !workload.control.observed.raw)
      errors.push('control observation');
    else validControl(workload, errors);
    validateRaw(workload, errors);
  }
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
  if (expectedKind === 'resource') validateResourceCells(cells, errors);
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
