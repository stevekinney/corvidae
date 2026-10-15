import { findInternalReadmeMarker } from './packaging.ts';

/** Public component subpaths differ from corvidae's root-only private source packages. */
const componentExports = {
  editor: {
    'diff-review': ['diff-review', ['DiffReview']],
    'diff-review-comments': ['diff-review-comments', ['DiffReviewComments']],
    'diff-viewer': ['diff-viewer', ['DiffViewer', 'DiffViewerAnnotationSelection']],
    'markdown-editor': ['markdown-editor', ['MarkdownEditor', 'EditorMode', 'MarkdownEditorProps']],
    'review-editor': ['review-editor', ['ReviewEditor', 'Thread']],
  },
} as const;

type ComponentWorkspace = keyof typeof componentExports;

function isComponentWorkspace(value: string): value is ComponentWorkspace {
  return value === 'editor';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function importSubpaths(workspace: ComponentWorkspace): Map<string, string> {
  const symbols = new Map<string, string>();
  for (const [subpath, exports] of Object.values(componentExports[workspace])) {
    for (const symbol of exports) symbols.set(symbol, `@lostgradient/${workspace}/${subpath}`);
  }
  if (workspace === 'editor') {
    for (const symbol of diffReviewStateExports) {
      symbols.set(symbol, '@lostgradient/editor/diff-review-state');
    }
  }
  return symbols;
}

/**
 * Every name `components/editor/src/lib/diff-review-state/index.ts` exports apart from its test
 * fixtures. The public Editor root does not re-export them; they live on the
 * `@lostgradient/editor/diff-review-state` subpath. `source.test.ts` holds this list to that
 * module's exports, so a new one cannot be added there and missed here.
 */
export const diffReviewStateExports: readonly string[] = [
  'buildDiffReviewCapturedContext',
  'computeDiffReviewSnapshotId',
  'createDiffReviewState',
  'defaultDiffReviewClock',
  'defaultDiffReviewIdFactory',
  'DIFF_REVIEW_MUTATING_ACTION_TYPES',
  'DIFF_REVIEW_STATE_VERSION',
  'DiffReviewAction',
  'DiffReviewActionOptions',
  'DiffReviewAnchor',
  'DiffReviewCapturedContext',
  'DiffReviewClock',
  'DiffReviewComment',
  'DiffReviewCoordinateSpace',
  'DiffReviewDraft',
  'DiffReviewError',
  'DiffReviewErrorCode',
  'DiffReviewFileAnchor',
  'DiffReviewIdFactory',
  'DiffReviewMarkdownTargetInput',
  'DiffReviewRangeAnchor',
  'DiffReviewRawMapping',
  'DiffReviewResult',
  'DiffReviewReviewedMarker',
  'DiffReviewSerializedState',
  'DiffReviewSourceTargetInput',
  'DiffReviewState',
  'DiffReviewTargetInput',
  'DiffReviewTargetKind',
  'DiffReviewTargetRecord',
  'ensureDiffReviewNoPendingDrafts',
  'getDiffReviewPendingDrafts',
  'isCanonicalDiffReviewTimestamp',
  'isDiffReviewFileReviewed',
  'nextDiffReviewUpdatedAt',
  'reduceDiffReviewState',
  'restoreDiffReviewState',
  'serializeDiffReviewState',
  'validateDiffReviewAnchor',
  'validateDiffReviewTargetList',
  'validateSerializedDiffReviewState',
];

function rewriteCodeImports(
  code: string,
  packageName: string,
  symbols: ReadonlyMap<string, string>,
): string {
  const namedImport =
    /^([ \t]*)import( type)?\s*\{([^}]+)\}\s*from\s*(['"])(@lostgradient\/editor)\4;/gm;
  return code.replace(
    namedImport,
    (
      original,
      indent: string,
      type: string | undefined,
      names: string,
      quote: string,
      importedPackage: string,
    ) => {
      if (importedPackage !== packageName) return original;
      const groups = new Map<string, string[]>();
      for (const item of names
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)) {
        const symbol = item.replace(/^type\s+/, '').split(/\s+as\s+/)[0]!;
        const specifier = symbols.get(symbol) ?? packageName;
        const group = groups.get(specifier) ?? [];
        group.push(item);
        groups.set(specifier, group);
      }
      if (groups.size === 1 && groups.has(packageName)) return original;
      if (groups.size === 1) {
        const [specifier] = groups.keys();
        if (specifier !== undefined) {
          return original.replace(`${quote}${packageName}${quote}`, `${quote}${specifier}${quote}`);
        }
      }
      return [...groups]
        .map(
          ([specifier, items]) =>
            `${indent}import${type ?? ''} { ${items.join(', ')} } from ${quote}${specifier}${quote};`,
        )
        .join('\n');
    },
  );
}

/** Translate only example JSON emitted to the public Editor package. */
export function rewritePublishedComponentExamples(contents: Uint8Array, path: string): Uint8Array {
  const match = /^packages\/(editor)\/src\/lib\/components\/([^/]+)\/\2\.examples\.json$/.exec(
    path,
  );
  if (!match) return contents;
  const [, workspaceName, component] = match;
  if (
    workspaceName === undefined ||
    component === undefined ||
    !isComponentWorkspace(workspaceName)
  )
    return contents;
  const specification = (
    componentExports[workspaceName] as Record<string, readonly [string, readonly string[]]>
  )[component];
  if (specification === undefined)
    throw new Error(`${path}: public example component needs a declared subpath`);
  const packageName = `@lostgradient/${workspaceName}`;
  const [subpath, publicSymbols] = specification;
  const artifact: unknown = JSON.parse(new TextDecoder().decode(contents));
  if (
    !isRecord(artifact) ||
    artifact['component'] !== component ||
    artifact['import'] !== packageName ||
    !Array.isArray(artifact['examples'])
  ) {
    throw new Error(
      `${path}: expected a source example artifact for ${component} using ${packageName}`,
    );
  }
  const symbols = importSubpaths(workspaceName);
  const expectedImport = `${packageName}/${subpath}`;
  artifact['import'] = expectedImport;
  artifact['examples'] = artifact['examples'].map((example: unknown) => {
    if (!isRecord(example) || typeof example['code'] !== 'string')
      throw new Error(`${path}: example code is missing`);
    const code = rewriteCodeImports(example['code'], packageName, symbols);
    if (
      !publicSymbols.some((symbol) =>
        new RegExp(
          `import(?: type)?\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*'${expectedImport}'`,
        ).test(code),
      )
    ) {
      throw new Error(`${path}: example does not import ${component} from ${expectedImport}`);
    }
    return { ...example, code };
  });
  return new TextEncoder().encode(`${JSON.stringify(artifact, null, 2)}\n`);
}

/**
 * A fenced code block in a Markdown README: the opening fence (three or more backticks or
 * tildes, optionally indented, with its info string), the body, and a closing fence of the same
 * character at least as long. Only the body is handed to `rewriteCodeImports`, so prose that
 * happens to quote an import is never touched.
 */
const fencedCodeBlock = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^[ \t]*\2[`~]*[ \t]*$/gm;

/**
 * Translate a component README emitted to the public Editor package.
 *
 * The same file is read in two places: corvidae's playground renders it from workspace source,
 * where every component is a root export, and the public package ships it (the target's package
 * build copies it into `dist/components/<name>/README.md`), where components live on their own
 * subpaths. Emitted tests also read it — `review-editor-diff-review.test.ts` checks its props
 * table — so it cannot simply be dropped from emission (COR-1446). The fenced imports are
 * rewritten with the same symbol map the example sidecars use; the prose is written in corvidae to
 * read true for both audiences, and a README whose prose still carries an internal marker is
 * refused here rather than shipped.
 */
export function rewritePublishedComponentReadme(contents: Uint8Array, path: string): Uint8Array {
  const match = /^packages\/(editor)\/src\/lib\/components\/[^/]+\/README\.md$/.exec(path);
  const workspaceName = match?.[1];
  if (workspaceName === undefined || !isComponentWorkspace(workspaceName)) return contents;
  const packageName = `@lostgradient/${workspaceName}`;
  const symbols = importSubpaths(workspaceName);
  const source = new TextDecoder().decode(contents);
  const published = source.replace(
    fencedCodeBlock,
    (block: string, _indent: string, _fence: string, body: string) => {
      const bodyStart = block.indexOf('\n') + 1;
      return `${block.slice(0, bodyStart)}${rewriteCodeImports(body, packageName, symbols)}${block.slice(bodyStart + body.length)}`;
    },
  );
  const marker = findInternalReadmeMarker(published);
  if (marker !== undefined) {
    throw new Error(
      `${path}: a published component README still reads as corvidae's internal documentation (contains "${marker}"). Rewrite that prose in corvidae so it is true for a registry consumer too.`,
    );
  }
  const bareRootImport = findBareRootComponentImport(published, packageName, symbols);
  if (bareRootImport !== undefined) {
    throw new Error(
      `${path}: a published component README imports ${bareRootImport} from the bare ${packageName} root, which does not export it. Import it inside a fenced code block so the mirror can route it to its subpath.`,
    );
  }
  return published === source ? contents : new TextEncoder().encode(published);
}

/** The first subpath-only symbol a text still imports from the bare package root, if any. */
export function findBareRootComponentImport(
  text: string,
  packageName: string,
  symbols: ReadonlyMap<string, string>,
): string | undefined {
  const namedImport = /import(?: type)?\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2/g;
  for (const [, names, , specifier] of text.matchAll(namedImport)) {
    if (specifier !== packageName || names === undefined) continue;
    for (const item of names.split(',')) {
      const symbol = item
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0];
      if (symbol !== undefined && symbols.has(symbol)) return symbol;
    }
  }
  return undefined;
}

/** The subpath map for one public component package, for checks outside this module. */
export function publicComponentSymbols(workspace: 'editor'): ReadonlyMap<string, string> {
  return importSubpaths(workspace);
}
