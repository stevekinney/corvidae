/** Public component subpaths differ from corvidae's root-only private source packages. */
const componentExports = {
  chat: {
    'chat-composer-popover': [
      'composer-popover',
      ['ChatComposerPopover', 'ChatComposerPopoverSelection'],
    ],
    'chat-conversation-header': ['conversation-header', ['ChatConversationHeader']],
    'chat-conversation-list': [
      'conversation-list',
      ['ChatConversationList', 'ConversationSummary'],
    ],
    'chat-navigation-rail': ['navigation-rail', ['ChatNavigationRail']],
    'chat-sub-session': ['sub-session', ['ChatSubSession']],
  },
  editor: {
    'diff-review': ['diff-review', ['DiffReview']],
    'diff-review-comments': ['diff-review-comments', ['DiffReviewComments']],
    'diff-viewer': ['diff-viewer', ['DiffViewer', 'DiffViewerAnnotationSelection']],
    'markdown-editor': ['markdown-editor', ['MarkdownEditor', 'EditorMode', 'MarkdownEditorProps']],
    'review-editor': ['review-editor', ['ReviewEditor']],
  },
} as const;

type ComponentWorkspace = keyof typeof componentExports;

function isComponentWorkspace(value: string): value is ComponentWorkspace {
  return value === 'chat' || value === 'editor';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function importSubpaths(workspace: ComponentWorkspace): Map<string, string> {
  const symbols = new Map<string, string>();
  for (const [subpath, exports] of Object.values(componentExports[workspace])) {
    for (const symbol of exports) symbols.set(symbol, `@lostgradient/${workspace}/${subpath}`);
  }
  return symbols;
}

function rewriteCodeImports(
  code: string,
  packageName: string,
  symbols: ReadonlyMap<string, string>,
): string {
  const namedImport =
    /^([ \t]*)import( type)?\s*\{([^}]+)\}\s*from\s*(['"])(@lostgradient\/(?:chat|editor))\4;/gm;
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
      return [...groups]
        .map(
          ([specifier, items]) =>
            `${indent}import${type ?? ''} { ${items.join(', ')} } from ${quote}${specifier}${quote};`,
        )
        .join('\n');
    },
  );
}

/** Translate only example JSON emitted to a public Chat or Editor package. */
export function rewritePublishedComponentExamples(contents: Uint8Array, path: string): Uint8Array {
  const match = /^packages\/(chat|editor)\/src\/lib\/components\/([^/]+)\/\2\.examples\.json$/.exec(
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
  if (component === 'chat') return contents;
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
      !publicSymbols.some(
        (symbol) => code.includes(`{ ${symbol}`) || code.includes(`, ${symbol}`),
      ) ||
      !code.includes(`from '${expectedImport}'`)
    ) {
      throw new Error(`${path}: example does not import ${component} from ${expectedImport}`);
    }
    return { ...example, code };
  });
  return new TextEncoder().encode(`${JSON.stringify(artifact, null, 2)}\n`);
}
