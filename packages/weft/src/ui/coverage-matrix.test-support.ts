/**
 * The checker behind `coverage-matrix.test.ts`: it parses
 * `documentation/ui/coverage-matrix.md` and reports every way the table has
 * drifted from Weft's operation catalog or from the dashboard source.
 *
 * It is pure — file reads and `HttpClient` route recording come in through
 * {@link CoverageMatrixContext} — so the test can run it against the real
 * matrix and against deliberately broken copies of it.
 */

/** The table's columns, in order. A table with any other header is not the matrix. */
export const COVERAGE_MATRIX_COLUMNS = [
  'Operation',
  'Status',
  'Location',
  'Method',
  'Test',
  'Issue',
  'Reason',
] as const;

export type CoverageMatrixColumn = (typeof COVERAGE_MATRIX_COLUMNS)[number];

export type CoverageMatrixRow = Readonly<Record<CoverageMatrixColumn, string>>;

export const COVERAGE_STATUSES = ['exposed', 'tracked', 'not-in-dashboard'] as const;

/** One HTTP request: its method and its URL path. */
export interface RecordedRoute {
  readonly method: string;
  readonly path: string;
}

export interface CoverageMatrixContext {
  /** `CLIENT_OPERATION_NAMES`: every operation that needs a row. */
  readonly operationNames: readonly string[];
  /**
   * Surfaces Weft offers outside the operation catalog, keyed by row name. The
   * value is the text an `exposed` row's `Location` file must contain, since
   * these surfaces have no operation identifier to look for.
   */
  readonly nonCatalogSurfaces: Readonly<Record<string, string>>;
  /** Every REST binding in Weft's catalog, by operation name. */
  readonly restBindings: ReadonlyMap<string, readonly RecordedRoute[]>;
  /** Contents of a file relative to `packages/weft`, or `undefined` when it does not exist. */
  readonly readFile: (path: string) => string | undefined;
  /**
   * Invoke an `HttpClient` method with its example arguments and return the
   * request it sent, with `API_PREFIX` already removed from the path. Returns
   * `undefined` when the method has no example arguments.
   */
  readonly recordMethodRoute: (method: string) => Promise<RecordedRoute | undefined>;
}

const ISSUE_IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/u;

function splitTableLine(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/u, '').replace(/\|$/u, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function stripCode(cell: string): string {
  return cell.replaceAll('`', '').trim();
}

function isHeader(cells: readonly string[]): boolean {
  return (
    cells.length === COVERAGE_MATRIX_COLUMNS.length &&
    cells.every((cell, index) => cell === COVERAGE_MATRIX_COLUMNS[index])
  );
}

/**
 * Parse the matrix table out of a Markdown document. Throws when the document
 * has no table whose header is exactly {@link COVERAGE_MATRIX_COLUMNS}.
 */
export function parseCoverageMatrix(markdown: string): CoverageMatrixRow[] {
  const lines = markdown.split('\n');
  const headerIndex = lines.findIndex(
    (line) => line.trim().startsWith('|') && isHeader(splitTableLine(line)),
  );
  if (headerIndex === -1) {
    throw new Error(`No table with the columns ${COVERAGE_MATRIX_COLUMNS.join(', ')}.`);
  }
  const rows: CoverageMatrixRow[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim().startsWith('|')) break;
    const [operation, status, location, method, test, issue, reason] =
      splitTableLine(line).map(stripCode);
    rows.push({
      Operation: operation ?? '',
      Status: status ?? '',
      Location: location ?? '',
      Method: method ?? '',
      Test: test ?? '',
      Issue: issue ?? '',
      Reason: reason ?? '',
    });
  }
  return rows;
}

/** The identifiers in an `Issue` cell, which may list several separated by commas. */
export function issueIdentifiers(cell: string): string[] {
  return cell
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Whether a request path matches a binding path, where `:param` matches one non-empty segment. */
export function routePathMatches(bindingPath: string, requestPath: string): boolean {
  const bindingSegments = bindingPath.split('/');
  const requestSegments = requestPath.split('/');
  if (bindingSegments.length !== requestSegments.length) return false;
  return bindingSegments.every((segment, index) => {
    const requestSegment = requestSegments[index] ?? '';
    return segment.startsWith(':') ? requestSegment.length > 0 : segment === requestSegment;
  });
}

function checkRowSet(rows: readonly CoverageMatrixRow[], context: CoverageMatrixContext): string[] {
  const problems: string[] = [];
  const known = new Set([...context.operationNames, ...Object.keys(context.nonCatalogSurfaces)]);
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.Operation)) problems.push(`${row.Operation}: more than one row.`);
    seen.add(row.Operation);
    if (!known.has(row.Operation)) {
      problems.push(
        `${row.Operation}: not in CLIENT_OPERATION_NAMES and not a listed non-catalog surface.`,
      );
    }
  }
  for (const name of known) {
    if (!seen.has(name)) problems.push(`${name}: has no row.`);
  }
  return problems;
}

function checkIssueCell(row: CoverageMatrixRow): string[] {
  const identifiers = issueIdentifiers(row.Issue);
  const problems = identifiers
    .filter((identifier) => !ISSUE_IDENTIFIER.test(identifier))
    .map((identifier) => `${row.Operation}: "${identifier}" is not a Linear identifier.`);
  const valid = identifiers.filter((identifier) => ISSUE_IDENTIFIER.test(identifier));
  if (row.Status === 'tracked' && valid.length === 0) {
    problems.push(`${row.Operation}: a tracked row must name the Linear issue that exposes it.`);
  }
  return problems;
}

function locationReaches(
  row: CoverageMatrixRow,
  location: string,
  context: CoverageMatrixContext,
): boolean {
  const marker = context.nonCatalogSurfaces[row.Operation];
  if (marker !== undefined) return location.includes(marker);
  if (location.includes(`'${row.Operation}'`)) return true;
  return row.Method !== '' && location.includes(`client.${row.Method}(`);
}

function checkExposedRow(row: CoverageMatrixRow, context: CoverageMatrixContext): string[] {
  if (row.Location === '') return [`${row.Operation}: an exposed row must name its Location.`];
  const problems: string[] = [];
  const location = context.readFile(row.Location);
  if (location === undefined) {
    problems.push(`${row.Operation}: Location ${row.Location} does not exist.`);
  } else if (!locationReaches(row, location, context)) {
    problems.push(
      `${row.Operation}: Location ${row.Location} neither contains the operation identifier nor calls client.${row.Method || '<Method>'}(.`,
    );
  }
  if (row.Test === '') {
    problems.push(`${row.Operation}: an exposed row must name its Test.`);
  } else if (context.readFile(row.Test) === undefined) {
    problems.push(`${row.Operation}: Test ${row.Test} does not exist.`);
  }
  return problems;
}

async function checkMethodRoute(
  row: CoverageMatrixRow,
  context: CoverageMatrixContext,
): Promise<string[]> {
  if (row.Method === '') return [];
  const bindings = context.restBindings.get(row.Operation);
  if (bindings === undefined || bindings.length === 0) {
    return [`${row.Operation}: names Method ${row.Method} but has no REST binding to compare.`];
  }
  const route = await context.recordMethodRoute(row.Method);
  if (route === undefined) {
    return [`${row.Operation}: Method ${row.Method} has no example arguments in the test.`];
  }
  const matches = bindings.some(
    (binding) => binding.method === route.method && routePathMatches(binding.path, route.path),
  );
  if (matches) return [];
  const expected = bindings.map((binding) => `${binding.method} ${binding.path}`).join(' or ');
  return [
    `${row.Operation}: Method ${row.Method} sent ${route.method} ${route.path}, not ${expected}.`,
  ];
}

function checkRowShape(row: CoverageMatrixRow): string[] {
  const statuses: readonly string[] = COVERAGE_STATUSES;
  if (!statuses.includes(row.Status)) {
    return [`${row.Operation}: status "${row.Status}" is not one of ${statuses.join(', ')}.`];
  }
  if (row.Status === 'not-in-dashboard' && row.Reason === '') {
    return [`${row.Operation}: a not-in-dashboard row must state its reason.`];
  }
  return [];
}

/** Every problem with the matrix, or an empty array when it is honest. */
export async function checkCoverageMatrix(
  markdown: string,
  context: CoverageMatrixContext,
): Promise<string[]> {
  const rows = parseCoverageMatrix(markdown);
  const problems = checkRowSet(rows, context);
  for (const row of rows) {
    problems.push(...checkRowShape(row), ...checkIssueCell(row));
    if (row.Status === 'exposed') problems.push(...checkExposedRow(row, context));
    problems.push(...(await checkMethodRoute(row, context)));
  }
  return problems;
}
