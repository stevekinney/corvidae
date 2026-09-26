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

Diffing and templates are separate operations. `computeLineDiff` compares source strings; `renderTemplate` resolves placeholders and then returns sanitized HTML, not substituted Markdown. Both template functions require placeholder definitions; see [Template placeholders](#template-placeholders).

```typescript
import { computeLineDiff, renderTemplate } from '@lostgradient/markdown';

const diff = computeLineDiff('before\nafter', 'before\nupdated');
const html = renderTemplate(
  'Hello {{name}}',
  { name: 'World' },
  { definitions: { candidates: [{ path: 'name', types: ['string'] }] } },
);
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

## Template placeholders

`resolveTemplatePlaceholders(template, values, options)` fills `{{path}}` tokens in a Markdown template and returns `{ text, issues }`: the filled Markdown source and ordered `PlaceholderDiagnostic` entries. `options.definitions` is required and is the only allowlist; `valueMode` (`'text'` or `'markdown'`, default `'text'`) and `unresolved` (`'preserve'` or `'error'`, default `'preserve'`) are optional. `renderTemplate(template, values, options)` takes the same options and renders the filled source through the sanitized pipeline.

```typescript
import { PlaceholderTemplateError, resolveTemplatePlaceholders } from '@lostgradient/markdown';

const definitions = {
  schema: {
    type: 'object',
    properties: { user: { type: 'object', properties: { name: { type: 'string' } } } },
  },
};
const { text, issues } = resolveTemplatePlaceholders(
  'Hello **{{user.name}}**, `{{user.name}}` stays literal. {{missing}}',
  { user: { name: 'Ada <3' } },
  { definitions },
);
// text: 'Hello **Ada&#32;&#60;3**, `{{user.name}}` stays literal. {{missing}}'
// issues: [{ code: 'unknown_placeholder', path: 'missing', location: { kind: 'token', … } }]

try {
  resolveTemplatePlaceholders('{{missing}}', {}, { definitions, unresolved: 'error' });
} catch (error) {
  if (error instanceof PlaceholderTemplateError) console.log(error.issues);
}
```

Tokens are `{{path}}` with optional spaces or tabs inside the delimiters; no token spans a line ending. They are active only in ordinary paragraph text, headings, list items, blockquotes, table cells, footnotes and bracketed link labels. Front matter (an exact `---` … `---` prefix at offset zero), code, raw HTML, math, link and image destinations and titles, reference definitions, image alt text and autolinks stay literal, decided by Markdown structure rather than a global regular expression. Each Markdown text run is scanned separately, so a token never spans a formatting boundary: characters that form emphasis split a would-be token, so a declared path such as `_meta_` cannot be written as raw `{{_meta_}}` (the underscores form emphasis, and the result is a `malformed_token`). Its backslash-escaped form `{{\_meta\_}}`, which is what the serializer writes, does resolve to `_meta_` (see the escape rule below). A path starting with `__` is reserved and never resolves in any form. Dollar-delimited math is excluded too, and it can reach across tokens: in `Was ${{old}}, now ${{new}}.`, remark-math reads `${{old}}, now $` as inline math, so `{{old}}` is never scanned and produces no diagnostic, even with `unresolved: 'error'`. An opening `{{` preceded by an odd number of backslashes, or written with character references such as `&#123;`, is literal; triple braces and nested `{{` are one `malformed_token`. Inside a token's body, a backslash immediately before a CommonMark-escapable ASCII punctuation character (``!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~``) is a backslash escape: read left to right, it contributes that punctuation character and consumes both, so `{{user\_name}}` resolves to path `user_name` and `{{\\_}}` (an escaped backslash followed by `_`) resolves to path `\_`. Any other backslash, including one with nothing after it, stays in the path as itself, so `{{user\name}}` resolves to path `user\name` (then `invalid_path_format`). This matters because the Markdown serializer (`normalize`, and Milkdown's `getMarkdown()`) backslash-escapes ASCII punctuation in text, turning `{{user_name}}` into `{{user\_name}}` on a rich-mode round trip; resolving the escape is what keeps such a path filling after one. Escapes affect only path extraction, after a token's boundaries are found: delimiter detection, the opening-delimiter backslash-parity rule, and malformed-span detection stay exactly as described above, blind to escapes inside the body. `parsePlaceholderTokens(text)` applies this grammar to one plain text run (the unit a rich-editor adapter scans), and `parseMarkdownPlaceholderTokens(source)` applies it to a whole Markdown template. Both report zero-based, end-exclusive UTF-16 offsets into the original source. `validatePlaceholderTokens(tokens, candidates)` returns the syntax and catalog diagnostics for parsed tokens.

Only declared paths are filled, from own data properties of plain objects; inherited properties, getters, `toJSON` and undeclared input keys never resolve. Each token gets at most one issue, the first that applies of `malformed_token`, `invalid_path_format`, `blocked_path`, `unknown_placeholder`, `missing_value` (no own property), `invalid_value` (`undefined`, bigint, symbols, functions, non-finite numbers, sparse arrays, accessors, cycles or non-plain objects in the referenced value) and `type_mismatch` (against declared `types`; `integer` accepts finite integers only). Missing and `null` differ: `null` is a value. Non-plain `values` (`invalid_values`), an invalid `valueMode` or `unresolved` string (`invalid_option`) or any definitions issue disables fill, returning the template unchanged with only those issues. Diagnostics never contain supplied values. In `'preserve'` mode unresolved tokens keep their original text; in `'error'` mode any issue throws `PlaceholderTemplateError` with the same ordered `issues` and no partial result.

Strings are inserted unchanged; numbers use JSON serialization (`-0` becomes `0`); `true`, `false` and `null` are written as such; arrays and objects become compact JSON with recursively sorted keys and original array order. In the default `'text'` mode every replacement is then encoded with decimal character references, keeping only ASCII letters and digits and code points at or above U+00A0, so `**important**` becomes `&#42;&#42;important&#42;&#42;` and renders literally; U+0000 and isolated surrogates first become visible `\u0000`-style text. Because letters and digits are kept, a value can still combine with template syntax next to the token: `{{n}}. item` with `n = 42` becomes `42. item`, an ordered list item, and `&{{x}};` with `x = 'lt'` becomes the entity `&lt;`. Keep such syntax out of the template around a token when that matters. In `'markdown'` mode string values are inserted raw and may add Markdown structure; every other JSON value keeps the literal encoding. Replacement text is never scanned for placeholders again. The resolver returns Markdown source, not safe HTML; `renderTemplate` sanitizes.

The parser and resolver subpaths (`./templates/types`, `./templates/template-placeholders` and `./templates/placeholder-security`) import no rendering, Shiki, KaTeX, DOM, Svelte or editor code from this package's source; `src/import-graph.test.ts` enforces that. They do import the headless `remark-math` parser to exclude math. At the installed versions, `remark-math@6.0.0` depends on `micromark-extension-math@3.1.0`, whose entry statically re-exports an HTML extension that imports `katex@0.16.47`. `remark-math` and `micromark-extension-math` declare `sideEffects: false`, so a bundler that honors it can drop that extension; `katex` declares no `sideEffects` field, and unbundled Bun evaluation still evaluates the `katex` module even though the parser never calls it. The package root re-exports rendering, so importing the root is never rendering-free.

## Placeholder utilities and diagnostics

Every function and type below is exported from the package root. The subpath column names the public subpath (from `scripts/mirror/package-surface.json`) that declares it; inside this workspace, import from the root.

| Export | Signature | Subpath |
| --- | --- | --- |
| `normalizePlaceholderDefinitions` | `(definitions: unknown) => NormalizedPlaceholderDefinitions` (`{ candidates, issues, enabled }`) | `./templates/template-placeholders` |
| `buildPlaceholderCandidatesFromJsonSchema` | `(schema: JsonSchemaObject) => PlaceholderCatalogResult` (`{ candidates, issues }`) | `./templates/template-placeholders` |
| `parsePlaceholderTokens` | `(text: string) => PlaceholderToken[]`, for one plain text run | `./templates/template-placeholders` |
| `parseMarkdownPlaceholderTokens` | `(source: string) => PlaceholderToken[]`, for a whole Markdown template | `./templates/template-placeholders` |
| `unescapePlaceholderBody` | `(body: string) => string`, the token-body escape rule on its own | `./templates/template-placeholders` |
| `validatePlaceholderTokens` | `(tokens: readonly PlaceholderToken[], candidates: readonly PlaceholderCandidate[]) => readonly PlaceholderDiagnostic[]` | `./templates/template-placeholders` |
| `resolveTemplatePlaceholders` | `(template: string, values: JsonObject, options: PlaceholderResolutionOptions) => PlaceholderResolutionResult` (`{ text, issues }`) | `./templates/template-placeholders` |
| `sortPlaceholderDiagnostics` | `(diagnostics: readonly PlaceholderDiagnostic[]) => PlaceholderDiagnostic[]`, the package's ordering and de-duplication rule | `./templates/template-placeholders` |
| `PlaceholderTemplateError` | `class extends Error`, `name: 'PlaceholderTemplateError'`, readonly `issues` | `./templates/template-placeholders` |
| `renderTemplate` | `(template: string, values: JsonObject, options: PlaceholderResolutionOptions) => string` (sanitized HTML) | `./templates/template-render` |
| `isBlockedSegment`, `isReservedSegment`, `RESERVED_SEGMENTS`, `PLACEHOLDER_SEGMENT_PATTERN` | the path-segment security predicate and its inputs | `./templates/placeholder-security` |
| `PlaceholderDefinitions`, `PlaceholderCandidate`, `PlaceholderSchemaType`, `PlaceholderDiagnostic`, `PlaceholderDiagnosticCode`, `PlaceholderDiagnosticLocation`, `PlaceholderToken`, `PlaceholderResolutionOptions`, `PlaceholderValueMode`, `PlaceholderUnresolvedMode`, `JsonValue`, `JsonObject`, `JsonSchemaObject` | types | `./templates/types` |

A `PlaceholderDiagnostic` is `{ code, message, path?, location }`. `location` is `{ kind: 'definition', pointer }` (an RFC 6901 JSON Pointer into the definitions object, such as `/schema/properties/user/properties/name` or `/candidates/0/types`), `{ kind: 'token', startOffset, endOffset }` (zero-based, end-exclusive UTF-16 offsets into the template), or `{ kind: 'configuration', property }` (`definitions`, `values`, `valueMode`, `unresolved`, or the component prop name). Definition and configuration diagnostics sort before token diagnostics, by pointer or property and then code; token diagnostics sort by start offset and then code; identical diagnostics appear once. No diagnostic ever contains a supplied value.

| Code | Location | Meaning |
| --- | --- | --- |
| `invalid_definitions` | configuration or definition | Definitions are not a plain object with exactly one of `schema` or `candidates`, or (in the editor) values were supplied without definitions. |
| `invalid_schema` | definition | A schema or property schema is not a supported plain object, or its `type` is malformed. |
| `unsupported_schema` | definition | `$ref`, `allOf`, `anyOf`, `oneOf`, `if`/`then`/`else`, `patternProperties` or schema-valued `additionalProperties` at a traversed position. |
| `cyclic_schema` | definition | A schema object appears inside itself on the traversal path. |
| `invalid_candidate` | definition | An explicit candidate is not a plain object, has an unknown field, or has an invalid path, `types`, `title` or `description`. |
| `duplicate_candidate` | definition | Two explicit candidates share a path. |
| `blocked_path` | definition or token | A path segment is reserved, such as `__proto__`, `constructor` or any `__` name. |
| `invalid_path_format` | definition or token | A path is not dot-separated ASCII identifiers (`[A-Za-z_][A-Za-z0-9_]*`). |
| `malformed_token` | token | Triple braces, a nested `{{`, an unclosed token, or a token split by Markdown formatting. |
| `unknown_placeholder` | token | A well-formed path that the catalog does not declare. |
| `missing_value` | token | The value object has no own property for a declared path. |
| `invalid_value` | token | The referenced value is not JSON data (see the list above). |
| `type_mismatch` | token | The referenced value does not match the declared `types`. |
| `invalid_values` | configuration | `values` is not a plain object. |
| `conflicting_configuration` | configuration | The editor received `placeholderDefinitions` together with the low-level props. |
| `invalid_option` | configuration | An unknown `valueMode`, `unresolved`, editor `mode` or `placeholderValueMode` string. |

## Placeholder security boundary

Placeholders read data; they never execute it. Only paths declared by the definitions resolve, and only through own data properties of plain objects and dense arrays, so prototype properties, getters, `toJSON`, functions and undeclared keys are never read or called, and reserved segments are blocked everywhere by the one `isBlockedSegment` predicate. Schemas are never fetched: `$ref` is reported, not followed. Replacement text is never parsed for placeholders a second time. `valueMode: 'text'` encodes every replacement so values cannot add Markdown structure; `valueMode: 'markdown'` lets string values add Markdown, and `renderTemplate` still passes all of it, including Markdown from values, through the same sanitizer and URL rules as any other Markdown, so script tags, event-handler attributes and unsafe URLs are removed. `resolveTemplatePlaceholders` returns Markdown source and makes no claim that it is safe HTML; render it through `renderTemplate` or the sanitized pipeline. Diagnostics never include values, and nothing here persists, logs or transmits them. One caching note: `renderMarkdown`'s module-level result cache holds recently rendered HTML, which for `renderTemplate` includes filled values, in memory for the life of the module. Keeping filled values out of that cache is tracked in COR-1323.

## Breaking changes

- `buildPlaceholderCandidatesFromJsonSchema(schema)` returned `PlaceholderCandidate[]`, silently skipping unsupported keywords and unaddressable property names. It now returns `{ candidates, issues }`, where `issues` holds `PlaceholderDiagnostic` entries located by JSON Pointers starting at `/schema`, and unsupported keywords, unaddressable or reserved names, malformed types and cycles are reported.
- `PlaceholderCandidate` changed from `{ path; description: string | undefined; valueKind: PlaceholderValueKind }` to `{ path; types?: readonly PlaceholderSchemaType[]; title?: string; description?: string }`. `PlaceholderValueKind` and `valueKind` are removed; `integer` is no longer collapsed into `number`, type unions are kept, and an omitted `types` means unknown.
- `resolveTemplatePlaceholders(template, values, candidatePaths?)` substituted every closed token, returned `{ text, issues: PlaceholderValidationIssue[] }`, and reported `unknown_placeholder` only when `candidatePaths` was given. It is now `resolveTemplatePlaceholders(template, values, options)` with required `options.definitions` and optional `valueMode` and `unresolved`, returns `{ text, issues: readonly PlaceholderDiagnostic[] }`, and fills only declared paths. The optional `candidatePaths` parameter is gone.
- Array, null and missing values changed. Before: arrays were comma-joined with `', '` (nested `null`/`undefined`/function/symbol items became empty strings and objects became `JSON.stringify` text), so `['a', 'b', 3]` became `a, b, 3`; `null` and `undefined` became `''`; a missing, inherited, reserved or unknown path became `''`; functions and symbols became `''`; bigint became its digits. After: arrays are compact JSON in order (`[1,"x"]`, encoded in text mode as `&#91;1&#44;&#34;x&#34;&#93;`); `null` becomes `null`; a missing own property is a `missing_value` issue and the token stays in the output (or throws in `'error'` mode); unknown, reserved and malformed tokens stay visible with an issue; `undefined`, bigint, functions, symbols, non-finite numbers, sparse arrays, accessors, cycles and non-plain objects are `invalid_value` issues. Objects now use recursively sorted keys.
- Default output is literal text. Before, replacement strings were inserted raw, so a value such as `**bold**` rendered as Markdown. Now every replacement is encoded with character references unless `valueMode: 'markdown'` is passed, which inserts string values raw.
- `renderTemplate(template, values)` is now `renderTemplate(template, values, options)` with the same required options, and throws `PlaceholderTemplateError` in `'error'` mode.
- `PlaceholderToken.closed: boolean` is replaced by `kind: 'placeholder' | 'malformed'`. Triple braces and nested opening delimiters are now one malformed token over the balanced span, unclosed tokens stop at the line end instead of running to the end of the text, backslash-escaped openers are literal, and no token spans a line ending. `parsePlaceholderTokens` still scans plain text; `parseMarkdownPlaceholderTokens` is the new Markdown-aware scanner the resolver uses.
- `validatePlaceholderTokens(tokens, candidates)` returned `{ validTokens, invalidTokens, issues }` with `{ token, reason }` issues. It now returns `readonly PlaceholderDiagnostic[]` whose `code` replaces `reason` and whose `location` (`{ kind: 'token', startOffset, endOffset }`) replaces `token`; it also reports `blocked_path`. `PlaceholderValidationIssue` and `PlaceholderValidationResult` are removed.
- `isBlockedSegment` moved from the `./templates/template-placeholders` module to `./templates/placeholder-security`. The package root still exports it.

## Development

From the repository root, run `bunx turbo run lint typecheck test --filter=@lostgradient/markdown`. Run `bun run validate` for the complete workspace.

## Provenance

This package absorbed the former workspace-private `@cinder/diff` package (word and line diffing) and the headless half of `@cinder/editor` (templating). The [migration inventory](../../MIGRATION.md) records that consolidation.
