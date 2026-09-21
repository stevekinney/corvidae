# @lostgradient/markdown

`@lostgradient/markdown` is a headless Markdown pipeline: [CommonMark](https://commonmark.org/) and [GitHub Flavored Markdown](https://github.github.com/gfm/) parsing, deterministic serialization, sanitized HTML rendering with math and syntax highlighting, word-level diffing, and placeholder templating. It has no Svelte dependency—use it from a server, a build script, or any other non-component context.

## Workspace usage

Declare `"@lostgradient/markdown": "workspace:*"` in the consuming workspace's dependencies. Install dependencies from the Corvidae root with `bun install --frozen-lockfile`. The private package exports TypeScript source from `@lostgradient/markdown`; the consumer compiles it. Shared external versions come from the root Bun catalog.

## Parse and serialize

Use `parse` when you want to inspect or transform a document's syntax tree. Its result distinguishes a parsed tree from a `MarkdownParseError`; `parseOrThrow` is the exception-based alternative. Serialization produces normalized Markdown, so keep the original string when exact source preservation matters.

```typescript
import { parse, serialize } from '@lostgradient/markdown';

const parsed = parse('# Hello *world*');
if (!parsed.success) throw parsed.error;
console.log(serialize(parsed.ast));
```

## Render HTML

`renderMarkdown` returns sanitized HTML alongside the original Markdown and code-block metadata. The returned `hadUnsafeContent` flag lets a host explain that content was removed without rendering the unsafe source as HTML.

```typescript
import { renderMarkdown } from '@lostgradient/markdown';

const result = renderMarkdown('# Hello\n\n[Project](https://example.com)');
console.log(result.html);
console.log(result.rawMarkdown); // Unchanged source for copy and export.
```

Rendering removes raw HTML and filters unsafe URLs. Data images are disabled by default; `allowDataImages` admits supported safe image MIME types. Use `stripLinks` when embedding rendered content inside an existing link. `nodePlaceholders` preserves code-block and table positions for a component renderer to replace.

The synchronous renderer omits math processing. Use `renderMarkdownWithMath` on the server or `renderMarkdownAsync` when rendering may use a browser worker. Both asynchronous paths load math support on demand; the consuming application supplies [KaTeX styles](https://katex.org/docs/browser.html) when displaying that output.

## Browser workers and highlighting

`renderMarkdownAsync` creates a shared worker lazily. Without a browser worker—or after a worker failure—it falls back to the math-capable main-thread path. Its asynchronous return type does not guarantee that rendering happens off the main thread.

`initializeWorkerHighlighter()` returns a boolean. Check it before treating worker output as highlighted; initialization failure still permits unhighlighted rendering. The application bundler must resolve the package's source worker entry and its grammar assets. Call `terminateMarkdownWorker()` when the application no longer owns rendering work; it resets the shared worker so a later call can create a new one. Coordinate that cleanup across consumers instead of terminating a worker still used elsewhere.

## Diffs and templates

Diffing and templates are separate operations. `computeLineDiff` compares source strings; `renderTemplate` resolves placeholders and then returns sanitized HTML, not substituted Markdown.

```typescript
import { computeLineDiff, renderTemplate } from '@lostgradient/markdown';

const diff = computeLineDiff('before\nafter', 'before\nupdated');
const html = renderTemplate('Hello {{name}}', { name: 'World' });
console.log(diff, html);
```

Use `resolveTemplatePlaceholders` when you need the substituted source and placeholder diagnostics before rendering. Import parsing, serialization, syntax-tree utilities, diffing, rendering, highlighting, templates, and URL utilities from the package root; there are no public package subpaths.

## Development

From the repository root, run `bunx turbo run lint typecheck test --filter=@lostgradient/markdown`. Run `bun run validate` for the complete workspace.

## Provenance

This package absorbed the former workspace-private `@cinder/diff` package (word and line diffing) and the headless half of `@cinder/editor` (templating). The [migration inventory](../../MIGRATION.md) records that consolidation.
