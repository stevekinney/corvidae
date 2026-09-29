import { buildBrowser } from '@lostgradient/testing';
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// BEGIN node-crypto-predicate
const nodeCryptoFindingKinds = [
  'metafile-import',
  'polyfill-input',
  'emitted-import',
  'build-log',
] as const;

type NodeCryptoFindingKind = (typeof nodeCryptoFindingKinds)[number];

interface NodeCryptoFinding {
  kind: NodeCryptoFindingKind;
  source: string | null;
}

interface NodeCryptoMetafileImport {
  path: string;
  original?: string;
}

interface NodeCryptoMetafile {
  inputs: Record<string, { imports: readonly NodeCryptoMetafileImport[] }>;
  outputs: Record<string, { imports: readonly NodeCryptoMetafileImport[] }>;
}

interface NodeCryptoLog {
  message: string;
  specifier?: string;
  referrer?: string;
  position?: { file: string } | null;
}

interface NodeCryptoEvidence {
  metafile: NodeCryptoMetafile | undefined;
  logs: readonly NodeCryptoLog[];
  files: ReadonlyMap<string, string>;
}

const nodeCryptoSpecifier = /^(node:)?crypto(\/|$)/;
const nodeCryptoLogReference = /(?<![\w./-])(?:node:)?crypto(?:\/[\w./-]*)?(?![\w-])/;
const nodeCryptoPolyfillInput = /^node:crypto$/;
const nodeCryptoImportKinds = new Set([
  'import-statement',
  'dynamic-import',
  'require-call',
  'require-resolve',
]);

function nodeCryptoResolutions(evidence: NodeCryptoEvidence): NodeCryptoFinding[] {
  const findings: NodeCryptoFinding[] = [];
  const { metafile } = evidence;
  if (metafile !== undefined) {
    for (const [source, entry] of Object.entries(metafile.inputs)) {
      if (nodeCryptoPolyfillInput.test(source))
        findings.push({ kind: 'polyfill-input', source: null });
      for (const record of entry.imports) {
        if (
          nodeCryptoSpecifier.test(record.path) ||
          nodeCryptoSpecifier.test(record.original ?? '')
        ) {
          findings.push({ kind: 'metafile-import', source });
        }
      }
    }
    for (const entry of Object.values(metafile.outputs)) {
      for (const record of entry.imports) {
        if (
          nodeCryptoSpecifier.test(record.path) ||
          nodeCryptoSpecifier.test(record.original ?? '')
        ) {
          findings.push({ kind: 'metafile-import', source: null });
        }
      }
    }
  }
  for (const log of evidence.logs) {
    const fields = [log.message, log.specifier ?? '', log.referrer ?? ''];
    if (fields.some((field) => nodeCryptoLogReference.test(field))) {
      findings.push({ kind: 'build-log', source: log.position?.file ?? null });
    }
  }
  const transpiler = new Bun.Transpiler({ loader: 'js' });
  for (const [name, text] of evidence.files) {
    for (const record of transpiler.scanImports(text)) {
      if (nodeCryptoImportKinds.has(record.kind) && nodeCryptoSpecifier.test(record.path)) {
        findings.push({ kind: 'emitted-import', source: name });
      }
    }
  }
  return findings;
}
// END node-crypto-predicate

const applicationRoot = join(import.meta.dir, '..', '..', '..');
const htmlEntrypoint = join(applicationRoot, 'scripts', 'browser', 'index.html');

async function readEmittedScripts(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(directory, { recursive: true })) {
    if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
      files.set(entry, await readFile(join(directory, entry), 'utf8'));
    }
  }
  return files;
}

const workDirectory = await mkdtemp(join(tmpdir(), 'weft-ui-bundle-portability-'));
afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

const shipped = await buildBrowser({
  entrypoints: [htmlEntrypoint],
  outdir: join(workDirectory, 'shipped'),
  development: false,
});
const shippedFiles = await readEmittedScripts(join(workDirectory, 'shipped'));

const controlEntrypoint = join(workDirectory, 'control-entry.ts');
await writeFile(
  controlEntrypoint,
  [
    "import { createHash } from 'node:crypto';",
    '(globalThis as Record<string, unknown>).portabilityControl = createHash;',
  ].join('\n'),
);
const controlOutdir = join(workDirectory, 'control');
let controlLogs: readonly NodeCryptoLog[] = [];
let controlMetafile: NodeCryptoMetafile | undefined;
try {
  const controlResult = await Bun.build({
    entrypoints: [controlEntrypoint],
    outdir: controlOutdir,
    target: 'browser',
    format: 'esm',
    metafile: true,
    throw: false,
  });
  controlLogs = controlResult.logs;
  controlMetafile = controlResult.metafile;
} catch (error) {
  controlLogs = error instanceof AggregateError ? (error.errors as NodeCryptoLog[]) : [];
}
const controlFiles = await readEmittedScripts(controlOutdir).catch(() => new Map<string, string>());

function emittedFindings(snippet: string): NodeCryptoFinding[] {
  return nodeCryptoResolutions({
    metafile: undefined,
    logs: [],
    files: new Map([['snippet.js', snippet]]),
  });
}

describe('weft-ui browser bundle portability', () => {
  it('bundles weft source and emits index.html', () => {
    const inputs = Object.keys(shipped.metafile?.inputs ?? {});
    expect(inputs.some((key) => key.includes('packages/weft/src/'))).toBe(true);
    const outputs = Object.keys(shipped.metafile?.outputs ?? {});
    expect(outputs.some((key) => key.endsWith('index.html'))).toBe(true);
  });

  it('resolves node:crypto nowhere in the shipped SPA', () => {
    expect(
      nodeCryptoResolutions({
        metafile: shipped.metafile,
        logs: shipped.logs,
        files: shippedFiles,
      }),
    ).toEqual([]);
  });

  it('detects a real static node:crypto import', () => {
    expect(controlFiles.size).toBeGreaterThan(0);
    expect(
      nodeCryptoResolutions({ metafile: controlMetafile, logs: controlLogs, files: controlFiles })
        .length,
    ).toBeGreaterThan(0);
  });

  it('declares the fixed finding kinds', () => {
    expect(nodeCryptoFindingKinds).toEqual([
      'metafile-import',
      'polyfill-input',
      'emitted-import',
      'build-log',
    ]);
  });

  it.each([
    "import { createHash } from 'node:crypto';",
    "import { createHash } from 'crypto';",
    "export { createHash } from 'node:crypto';",
    "import 'node:crypto';",
    "const loaded = await import('node:crypto');",
    "const loaded = require('crypto');",
  ])('flags emitted import form: %s', (snippet) => {
    expect(emittedFindings(snippet).length).toBeGreaterThan(0);
  });

  it.each([
    "const loaded = tryLoadNodeBuiltin('node:crypto');",
    "const loaded = process.getBuiltinModule('node:crypto');",
    "// import { createHash } from 'crypto'",
    'const text = "import { createHash } from \'crypto\'";',
    "const text = `import { createHash } from 'crypto'`;",
  ])('ignores non-import form: %s', (snippet) => {
    expect(emittedFindings(snippet)).toEqual([]);
  });

  it('flags a metafile import record and a resolve log', () => {
    const metafileFindings = nodeCryptoResolutions({
      metafile: {
        inputs: { 'a.ts': { imports: [{ path: 'node:crypto' }] } },
        outputs: {},
      },
      logs: [],
      files: new Map(),
    });
    expect(metafileFindings.map((finding) => finding.kind)).toContain('metafile-import');
    const logFindings = nodeCryptoResolutions({
      metafile: undefined,
      logs: [{ message: 'Could not resolve', specifier: 'node:crypto', referrer: 'a.ts' }],
      files: new Map(),
    });
    expect(logFindings.map((finding) => finding.kind)).toContain('build-log');
  });
});
