# @repo/markdown

`@repo/markdown` is a headless Markdown pipeline: CommonMark + GFM parsing and deterministic serialization, sanitized HTML rendering (with math and syntax highlighting), word-level diffing, and placeholder templating. It has no Svelte dependency—use it from a server, a build script, or any other non-component context.

## Workspace usage

Declare `"@repo/markdown": "workspace:*"` in the consuming workspace's dependencies. Install dependencies from the Corvidae root with `bun install --frozen-lockfile`. The private package exports TypeScript source from `@repo/markdown`; the consumer compiles it. Shared external versions come from the root Bun catalog.

## Usage

````ts
import { parse, serialize } from '@repo/markdown';
import { renderMarkdown } from '@repo/markdown';
import { computeLineDiff } from '@repo/markdown';
import { renderTemplate } from '@repo/markdown';

const parsed = parse('# Hello *world*');
if (parsed.success) serialize(parsed.ast);

const { html } = renderMarkdown('# Hi\n\n```ts\nconst x = 1;\n```');
const diff = computeLineDiff('a\nb', 'a\nc');
const filled = renderTemplate('Hello {{name}}', { name: 'World' });
````

## Public API

Import parsing, serialization, AST utilities, diffing, rendering, highlighting, templates, and URL utilities from `@repo/markdown`. Browser consumers can use `renderMarkdownAsync`, `initializeWorkerHighlighter`, and `terminateMarkdownWorker`; their application bundler resolves the source worker entry. There are no public package subpaths.

## Provenance

This package absorbed the former workspace-private `@cinder/diff` package (word/line diffing) and the headless half of `@cinder/editor` (templating)—see [`docs/decisions/package-boundaries.md`](https://github.com/stevekinney/cinder/blob/main/docs/decisions/package-boundaries.md) for the extraction history.
