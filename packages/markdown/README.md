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

Use `resolveTemplatePlaceholders` when you need the substituted source and placeholder diagnostics before rendering. Inside this workspace, import parsing, serialization, syntax-tree utilities, diffing, rendering, highlighting, templates, and URL utilities from the package root. The public package also declares the subpaths listed in `scripts/mirror/package-surface.json`: `./pipeline`, `./diff`, `./diff/line-diff`, `./diff/types`, `./rendering`, `./rendering/async`, `./rendering/types`, `./rendering/highlighter`, `./rendering/mermaid-cache`, `./utilities/safe-url`, `./utilities/sort-keys`, `./templates/sanitize-html`, `./templates/template-placeholders`, `./templates/template-render`, `./templates/placeholder-security`, and `./templates/types`.

## Placeholder catalogs

`normalizePlaceholderDefinitions(definitions)` turns placeholder definitions into the allowlist every placeholder feature shares. Definitions contain exactly one of `schema` (a JSON Schema object, the recommended path) or `candidates` (explicit `{ path, types?, title?, description? }` metadata). It returns sorted `candidates`, ordered `issues`, and `enabled`. Any issue sets `enabled` to `false`, which disables completion and fill until the definitions are fixed; `candidates` still lists the valid partial entries. A valid empty catalog is enabled and permits no paths.

```typescript
import { normalizePlaceholderDefinitions } from '@lostgradient/markdown';

const catalog = normalizePlaceholderDefinitions({
  schema: {
    type: 'object',
    properties: {
      user: { type: 'object', properties: { name: { type: 'string', title: 'Name' } } },
      tags: { type: 'array', items: { type: 'string' } },
    },
  },
});
// catalog.enabled === true; catalog.candidates paths: tags, user, user.name
```

Schema extraction is catalog extraction, not instance validation. It reads a root object schema and recursively declared `properties`, emitting whole objects, whole arrays and nested properties; `items` never creates indexed paths. `type` may be one of `string`, `number`, `integer`, `boolean`, `null`, `object` and `array`, or a list of them; an absent type is unknown. `title` and `description` are display metadata. `required`, `enum`, `const`, `default`, `examples`, `format`, numeric and string constraints, unused `$defs` and boolean `additionalProperties` are neither enforced nor used as values. `$ref`, `allOf`, `anyOf`, `oneOf`, `if`/`then`/`else`, `patternProperties` and schema-valued `additionalProperties` are reported as `unsupported_schema`, never followed, and never fetched. Property names must be ASCII identifiers (`[A-Za-z_][A-Za-z0-9_]*`) that are not reserved (`__proto__`, `constructor`, any `__` name, and similar, case-insensitively); other names are reported at their JSON Pointer rather than skipped.

Definitions must be plain data: objects whose prototype is `null` or this realm's `Object.prototype`, read through own data properties. Getters are never invoked, and class instances, foreign-realm objects and accessor properties are reported. Transfer cross-realm data into the receiving realm first. Executable Proxy objects are outside the supported contract: JavaScript cannot reliably detect every proxy, so no guarantee is made that proxy traps do not run.

## Breaking changes

- `buildPlaceholderCandidatesFromJsonSchema(schema)` returned `PlaceholderCandidate[]`, silently skipping unsupported keywords and unaddressable property names. It now returns `{ candidates, issues }`, where `issues` holds `PlaceholderDiagnostic` entries located by JSON Pointers starting at `/schema`, and unsupported keywords, unaddressable or reserved names, malformed types and cycles are reported.
- `PlaceholderCandidate` changed from `{ path; description: string | undefined; valueKind: PlaceholderValueKind }` to `{ path; types?: readonly PlaceholderSchemaType[]; title?: string; description?: string }`. `PlaceholderValueKind` and `valueKind` are removed; `integer` is no longer collapsed into `number`, type unions are kept, and an omitted `types` means unknown.
- `isBlockedSegment` moved from the `./templates/template-placeholders` module to `./templates/placeholder-security`. The package root still exports it.

## Development

From the repository root, run `bunx turbo run lint typecheck test --filter=@lostgradient/markdown`. Run `bun run validate` for the complete workspace.

## Provenance

This package absorbed the former workspace-private `@cinder/diff` package (word and line diffing) and the headless half of `@cinder/editor` (templating). The [migration inventory](../../MIGRATION.md) records that consolidation.
