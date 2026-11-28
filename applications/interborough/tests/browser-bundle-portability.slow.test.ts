import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { buildNativeDocuments } from '../scripts/build-native-documents.ts';

it('bundles the plain Reviews client without Svelte, Cinder or server modules', async () => {
  const result = await Bun.build({
    entrypoints: [
      resolve(
        import.meta.dir,
        '../../../packages/bureau-sdk/src/generated/portable-operation-client.generated.ts',
      ),
    ],
    target: 'browser',
    metafile: true,
  });
  expect(result.success).toBe(true);
  const inputs = Object.keys(result.metafile?.inputs ?? {});
  expect(inputs.length).toBeGreaterThan(0);
  expect(inputs.filter((path) => /(?:^|\/)(?:svelte|cinder|server)(?:\/|$)/u.test(path))).toEqual(
    [],
  );
});

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

const applicationRoot = join(import.meta.dir, '..');

async function readEmittedScripts(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(directory, { recursive: true })) {
    if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
      files.set(entry, await readFile(join(directory, entry), 'utf8'));
    }
  }
  return files;
}

const workDirectory = await mkdtemp(join(tmpdir(), 'interborough-bundle-portability-'));
afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

let shippedMetadata: Bun.BuildMetafile | undefined;
let shippedBuildError: unknown;
let shippedFiles = new Map<string, string>();
try {
  const shipped = await buildNativeDocuments(join(workDirectory, 'shipped'), {
    onBuildMetadata({ browser }) {
      shippedMetadata = browser;
    },
  });
  shippedFiles = await readEmittedScripts(join(shipped.directory, 'browser'));
} catch (error) {
  shippedBuildError = error;
}

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

describe('interborough browser bundle portability', () => {
  it('builds the shipped native graph without errors or warnings', () => {
    const failures =
      shippedBuildError instanceof AggregateError
        ? shippedBuildError.errors.map((entry) => String(entry?.message ?? entry))
        : shippedBuildError === undefined
          ? []
          : [
              shippedBuildError instanceof Error
                ? shippedBuildError.message
                : JSON.stringify(shippedBuildError),
            ];
    expect(failures).toEqual([]);
  });

  it('bundles Weft source and emits a native browser registry', () => {
    // Metafile inputs are relative to the working directory, so they are resolved before asking
    // whether Weft's source was bundled.
    const weftSource = `${resolve(applicationRoot, '..', '..', 'packages', 'weft', 'src')}${sep}`;
    const inputs = Object.keys(shippedMetadata?.inputs ?? {}).map((key) => resolve(key));
    expect(inputs.some((path) => path.startsWith(weftSource))).toBe(true);
    const outputs = Object.keys(shippedMetadata?.outputs ?? {});
    expect(outputs.some((key) => /browser-registry-.+\.js$/u.test(key))).toBe(true);
  });

  it('resolves node:crypto nowhere in the shipped native graph', () => {
    expect(
      nodeCryptoResolutions({
        metafile: shippedMetadata,
        logs:
          shippedBuildError instanceof AggregateError
            ? (shippedBuildError.errors as NodeCryptoLog[])
            : [],
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
