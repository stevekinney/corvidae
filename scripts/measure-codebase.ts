import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { parse, type AST } from 'svelte/compiler';

type Role =
  | 'Documentation'
  | 'Declarations'
  | 'Tests'
  | 'Fixtures/examples'
  | 'Tooling/configuration'
  | 'Implementation'
  | 'Other text';
type FileRow = {
  file: string;
  workspace: string;
  role: Role;
  extension: string;
  lines: number;
  nonblank: number;
  bytes: number;
  code: boolean;
  sha256: string;
};
type ExcludedRow = { file: string; reason: string; bytes?: number };
type TemplateRow = {
  file: string;
  ifBlocks: number;
  eachBlocks: number;
  awaitBlocks: number;
  snippets: number;
  conditionalExpressions: number;
  logicalExpressions: number;
  inlineFunctionRoots: number;
};
type TemplateFunction = { start: number; end: number };
type MappingSegment = { generatedStart: number; generatedEnd: number; originalStart: number };
type TemplateMapping = { file: string; text: string; content: string; segments: MappingSegment[] };
type ComplexityUnit = {
  file: string;
  workspace: string;
  role: Role;
  line: number;
  column: number;
  label: string;
  complexity: number;
  lines: number;
  kind: string;
  excerpt: string;
};
type Diagnostic = {
  code: string;
  message: string;
  filename: string;
  labels: Array<{ span?: Span }>;
};
type Span = { line: number; column: number; offset: number; length: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAstNode(
  value: unknown,
): value is AST.SvelteNode & { type?: string; start?: number; end?: number } {
  return (
    isRecord(value) && (typeof value['type'] === 'string' || typeof value['start'] === 'number')
  );
}
function numberProperty(value: Record<string, unknown>, key: string): number {
  const result = value[key];
  if (typeof result !== 'number') throw new Error(`Invalid numeric property ${key}`);
  return result;
}

const root = process.cwd();
const output = process.argv[2] ?? '/tmp/corvidae-baseline';
mkdirSync(output, { recursive: true });
const configuration = {
  plugins: [],
  categories: { correctness: 'off' },
  rules: { complexity: ['warn', { max: 0, variant: 'classic' }] },
};
await Bun.write(`${output}/complexity-configuration.json`, JSON.stringify(configuration));
const listing = Bun.spawnSync(['git', 'ls-files', '-c', '-o', '--exclude-standard', '-z'], {
  cwd: root,
});
if (listing.exitCode !== 0) throw new Error('Git inventory failed');
const paths = [...new Set(listing.stdout.toString().split('\0').filter(Boolean))].toSorted();
const codeExtensions = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.svelte',
  '.css',
  '.scss',
  '.sass',
  '.html',
  '.sql',
  '.sh',
]);
const executableExtensions = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.svelte',
]);
const textExtensions = new Set([
  ...codeExtensions,
  '.md',
  '.mdx',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.txt',
  '.svg',
  '.xml',
  '.csv',
  '.patch',
]);
const rows: FileRow[] = [];
const excluded: ExcludedRow[] = [];
const missing: string[] = [];
const templates: TemplateRow[] = [];
const templateFailures: Array<{ file: string; error: string }> = [];
const mappings = new Map<string, TemplateMapping>();
const sha = createHash('sha256');
function role(path: string, extension: string): Role {
  if (/\.(md|mdx)$/.test(path) || /(^|\/)documentation\//.test(path)) return 'Documentation';
  if (/\.d\.(ts|mts|cts)$/.test(path) && !/test|fixture/.test(path)) return 'Declarations';
  if (
    /(^|\/)(tests?|__tests__)\//.test(path) ||
    /\.(test|spec|e2e|test-d|type-test|playwright)\./.test(path) ||
    /(?:^|[-/])test-(helpers|fixtures|utilities|readers)/.test(path) ||
    /\.test-support\./.test(path)
  )
    return 'Tests';
  if (
    /(^|\/)(__fixtures__|fixtures|examples|benchmarks)\//.test(path) ||
    /\.(fixture|example)\./.test(path)
  )
    return 'Fixtures/examples';
  if (
    /(^|\/)(scripts|\.agents|\.codex|\.claude|\.vscode)\//.test(path) ||
    (!path.startsWith('applications/') &&
      !path.startsWith('components/') &&
      !path.startsWith('packages/')) ||
    /(^|\/)([^/]*config[^/]*|package\.json|bunfig\.toml)$/.test(path) ||
    ['.json', '.jsonc', '.toml', '.yaml', '.yml'].includes(extension)
  )
    return 'Tooling/configuration';
  return codeExtensions.has(extension) ? 'Implementation' : 'Other text';
}
function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}
function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}
function templateData(text: string, file: string): TemplateFunction[] {
  const ast = parse(text, { modern: true });
  const functions: TemplateFunction[] = [];
  const counts = {
    ifBlocks: 0,
    eachBlocks: 0,
    awaitBlocks: 0,
    snippets: 0,
    conditionalExpressions: 0,
    logicalExpressions: 0,
  };
  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isAstNode(node)) return;
    if (node.type === 'IfBlock') counts.ifBlocks++;
    if (node.type === 'EachBlock') counts.eachBlocks++;
    if (node.type === 'AwaitBlock') counts.awaitBlocks++;
    if (node.type === 'SnippetBlock') counts.snippets++;
    if (node.type === 'ConditionalExpression') counts.conditionalExpressions++;
    if (node.type === 'LogicalExpression') counts.logicalExpressions++;
    if (
      ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(
        node.type ?? '',
      ) &&
      typeof node.start === 'number' &&
      typeof node.end === 'number'
    ) {
      functions.push({ start: node.start, end: node.end });
      return;
    }
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'parent', 'metadata'].includes(key)) walk(value);
  }
  walk(ast.fragment);
  templates.push({ file, ...counts, inlineFunctionRoots: functions.length });
  return functions;
}
for (const file of paths) {
  if (
    /(^|\/)(\.env[^/]*|node_modules|\.git|build|dist|coverage|\.svelte-kit|\.turbo|\.cache|\.playwright|playwright-report|test-results)(\/|$)/.test(
      file,
    ) ||
    file.startsWith('documentation/reports/codebase-baseline/')
  ) {
    excluded.push({ file, reason: 'Local, generated, secret-name, or report output' });
    continue;
  }
  let stat;
  try {
    stat = lstatSync(resolve(root, file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    missing.push(file);
    continue;
  }
  if (!stat.isFile()) {
    excluded.push({ file, reason: 'Non-regular file or symlink' });
    continue;
  }
  if (/\.generated\.|\.tsbuildinfo$|(^|\/)(bun\.lock|package-lock\.json)$/.test(file)) {
    excluded.push({ file, reason: 'Generated artifact or lockfile' });
    continue;
  }
  const extension = extname(file);
  if (
    !textExtensions.has(extension) &&
    !['LICENSE', '.gitignore', '.prettierignore', '.editorconfig'].includes(file)
  ) {
    excluded.push({ file, reason: 'Binary asset or unsupported text extension', bytes: stat.size });
    continue;
  }
  const buffer = readFileSync(resolve(root, file));
  if (buffer.includes(0)) {
    excluded.push({ file, reason: 'Binary content', bytes: buffer.length });
    continue;
  }
  const text = buffer.toString('utf8');
  const workspace = /^(applications|components|packages|internal)\/[^/]+\//.test(file)
    ? file.split('/').slice(0, 2).join('/')
    : '(root)';
  const digest = createHash('sha256').update(buffer).digest('hex');
  sha.update(file).update('\0').update(digest).update('\n');
  rows.push({
    file,
    workspace,
    role: role(file, extension),
    extension,
    lines: lineCount(text),
    nonblank: text.split('\n').filter((line) => line.trim().length).length,
    bytes: buffer.length,
    code: codeExtensions.has(extension),
    sha256: digest,
  });
  if (extension === '.svelte') {
    try {
      const functions = templateData(text, file);
      if (functions.length) {
        const virtual = `${output}/template-functions/${file}.ts`;
        let content = '';
        const segments: MappingSegment[] = [];
        for (const fn of functions) {
          content += 'void (';
          const generatedStart = Buffer.byteLength(content);
          const source = text.slice(fn.start, fn.end);
          segments.push({
            generatedStart,
            generatedEnd: generatedStart + Buffer.byteLength(source),
            originalStart: fn.start,
          });
          content += source + ');\n';
        }
        await Bun.write(virtual, content);
        mappings.set(virtual, { file, text, content, segments });
      }
    } catch (error) {
      templateFailures.push({ file, error: String(error) });
    }
  }
}
const byFile = new Map(rows.map((row) => [row.file, row]));
const units: ComplexityUnit[] = [];
const diagnostics: Diagnostic[] = [];
async function collect(files: string[], isTemplate: boolean) {
  for (let offset = 0; offset < files.length; offset += 400) {
    const child = Bun.spawn(
      [
        'bunx',
        'oxlint',
        '--config',
        `${output}/complexity-configuration.json`,
        '--no-ignore',
        '--format',
        'json',
        ...files.slice(offset, offset + 400),
      ],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0)
      throw new Error(`Analyzer exited ${exitCode}: ${stderr}\n${stdout.slice(0, 2000)}`);
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed) || !Array.isArray(parsed['diagnostics']))
      throw new Error('Invalid analyzer output');
    for (const value of parsed['diagnostics']) {
      if (!isRecord(value)) throw new Error('Invalid analyzer diagnostic');
      const code = typeof value['code'] === 'string' ? value['code'] : '';
      const message = typeof value['message'] === 'string' ? value['message'] : '';
      const filename = typeof value['filename'] === 'string' ? value['filename'] : '';
      const labels = Array.isArray(value['labels'])
        ? value['labels'].filter(isRecord).map((label) => {
            const span = label['span'];
            if (!isRecord(span)) throw new Error('Invalid analyzer span');
            return {
              span: {
                line: numberProperty(span, 'line'),
                column: numberProperty(span, 'column'),
                offset: numberProperty(span, 'offset'),
                length: numberProperty(span, 'length'),
              },
            };
          })
        : [];
      const diagnostic: Diagnostic = { code, message, filename, labels };
      if (diagnostic.code !== 'eslint(complexity)') {
        diagnostics.push(diagnostic);
        continue;
      }
      const firstLabel = diagnostic.labels[0];
      if (!diagnostic.message || !diagnostic.filename || !firstLabel?.span)
        throw new Error('Incomplete complexity diagnostic');
      const match = diagnostic.message.match(/^(.*?) has a complexity of (\d+)\./);
      if (!match) throw new Error(`Unknown diagnostic ${diagnostic.message}`);
      const span = firstLabel.span;
      let file = diagnostic.filename;
      let line = span.line;
      let column = span.column;
      let source: string;
      if (isTemplate) {
        const mapping = mappings.get(file);
        if (!mapping) throw new Error(`Missing mapping ${file}`);
        const segment = mapping.segments.find(
          (segmentValue) =>
            span.offset >= segmentValue.generatedStart && span.offset < segmentValue.generatedEnd,
        );
        if (!segment) throw new Error('Unmapped template span');
        const virtualBuffer = Buffer.from(mapping.content);
        const originalOffset =
          segment.originalStart +
          virtualBuffer.subarray(segment.generatedStart, span.offset).toString().length;
        line = lineAt(mapping.text, originalOffset);
        column = originalOffset - mapping.text.lastIndexOf('\n', originalOffset - 1);
        source = virtualBuffer.subarray(span.offset, span.offset + span.length).toString();
        file = mapping.file;
      } else {
        file = file.replace(`${root}/`, '');
        source = readFileSync(resolve(root, file))
          .subarray(span.offset, span.offset + span.length)
          .toString();
      }
      const owner = byFile.get(file);
      if (!owner) throw new Error(`File outside inventory ${file}`);
      units.push({
        file,
        workspace: owner.workspace,
        role: owner.role,
        line,
        column,
        label: match[1] ?? 'unknown',
        complexity: Number(match[2]),
        lines: lineCount(source),
        kind: (match[1] ?? '').startsWith('class ')
          ? 'Implicit class unit'
          : isTemplate
            ? 'Template function'
            : 'Function',
        excerpt: (source.split('\n')[0] ?? '').slice(0, 140),
      });
    }
  }
}
await collect(
  rows.filter((row) => executableExtensions.has(row.extension)).map((row) => row.file),
  false,
);
await collect([...mappings.keys()], true);
if (diagnostics.length || templateFailures.length) {
  await Bun.write(
    `${output}/parse-findings.json`,
    JSON.stringify({ diagnostics, templateFailures }, null, 2),
  );
  throw new Error(
    `Unexpected parse findings: ${diagnostics.length} native, ${templateFailures.length} template`,
  );
}
function percentile(values: number[], quantile: number) {
  if (!values.length) return 0;
  const sorted = [...values].toSorted((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const lowerValue = sorted[lower];
  const upperValue = sorted[Math.ceil(position)];
  if (lowerValue === undefined || upperValue === undefined) throw new Error('Invalid percentile');
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}
function statistics(values: number[]) {
  return {
    count: values.length,
    total: values.reduce((a, b) => a + b, 0),
    median: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    maximum: Math.max(0, ...values),
  };
}
const groups = [
  'Implementation',
  'Tests',
  'Fixtures/examples',
  'Tooling/configuration',
  'Declarations',
  'Documentation',
  'Other text',
];
const summary = {
  generatedAt: new Date().toISOString(),
  root,
  head: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
  workingTree: true,
  digest: sha.digest('hex'),
  oxlint: Bun.spawnSync(['bunx', 'oxlint', '--version']).stdout.toString().trim(),
  files: rows.length,
  codeFiles: rows.filter((row) => row.code).length,
  physicalLines: statistics(rows.filter((row) => row.code).map((row) => row.lines)),
  complexity: statistics(units.map((unit) => unit.complexity)),
  templateFunctions: units.filter((unit) => unit.kind === 'Template function').length,
  classUnits: units.filter((unit) => unit.kind === 'Implicit class unit').length,
  excluded: excluded.length,
  missingTrackedPaths: missing.length,
  roles: groups.map((name) => ({
    role: name,
    code: statistics(rows.filter((row) => row.role === name && row.code).map((row) => row.lines)),
    text: statistics(rows.filter((row) => row.role === name).map((row) => row.lines)),
    complexity: statistics(
      units.filter((unit) => unit.role === name).map((unit) => unit.complexity),
    ),
  })),
  workspaces: [...new Set(rows.map((row) => row.workspace))].toSorted().map((name) => ({
    workspace: name,
    code: statistics(
      rows.filter((row) => row.workspace === name && row.code).map((row) => row.lines),
    ),
    roles: Object.fromEntries(
      groups.map((group) => [
        group,
        rows
          .filter((row) => row.workspace === name && row.role === group && row.code)
          .reduce((total, row) => total + row.lines, 0),
      ]),
    ),
    complexity: statistics(
      units.filter((unit) => unit.workspace === name).map((unit) => unit.complexity),
    ),
    implementationComplexity: statistics(
      units
        .filter((unit) => unit.workspace === name && unit.role === 'Implementation')
        .map((unit) => unit.complexity),
    ),
  })),
};
for (const [name, value] of Object.entries({
  summary,
  files: rows,
  complexity: units,
  templates,
  excluded,
  missing,
}))
  await Bun.write(`${output}/${name}.json`, JSON.stringify(value, null, 2));
