# CodeBlock

Renders preformatted source code with optional client-side syntax highlighting and copy controls. The first paint may be the escaped plain-code fallback; when highlighting resolves, the block keeps the same layout metrics.

CodeBlock imports no highlighter of its own, so a consumer bundle carries only the grammars it chooses. A block highlights with its `highlighter` prop, else with the highlighter an ancestor publishes through `setCodeHighlighterContext`, and renders plain code with neither. Build a highlighter with `shikiHighlighter` over the grammars your application renders, or use `fullShikiHighlighter` for every grammar Shiki ships.

## Usage

```svelte
<script lang="ts">
  import { CodeBlock } from '@lostgradient/cinder';
  const code = `function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

const message = greet('world');`;
</script>

<CodeBlock {code} />
```

## Line numbers and notes

`lineNumbers` numbers each line in a gutter on the left. The numbers are generated content: a selection copies the code without them, and they are kept out of the accessibility tree. A wrapped line (`wrap`) is numbered once, and the gutter is as wide as the last number.

`annotations` draws a note under a line, for a file problem or a warning: the line's row takes the tone's tint, its number turns to the tone's color, and the note sits directly beneath with a glyph.

```svelte
<CodeBlock
  {code}
  language="json"
  lineNumbers
  annotations={[{ line: 11, message: 'Missing comma at the end of this line.' }]}
/>
```

Plain code is split into lines by the block itself. Highlighted code is decorated after it renders, which needs a highlighter that wraps each line in an element with the class `line`, as Shiki does; a highlighter that returns a single `<code>` element cannot be numbered, so the block shows the plain, numbered rendering instead.

## Scrolling and wrapping

A code block scrolls inside its own box, with a scrollbar that is always painted from the shared scrollbar tokens. `wrap` breaks a long line instead.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-code-block`. |
| `code` | `string` | yes | — | The code to render. |
| `copyable` | `boolean` | no | — | When true, render an icon-only copy button above the code. The block has no header bar or frame. |
| `copyFloating` | `boolean` | no | `false` | Float the copy button (and the language label, when shown) over the top inline-end corner of the code instead of giving them a row above it. The copy button is named for the language it copies, such as "Copy sql code". Defaults to `false`. |
| `highlight` | `boolean` | no | — | Whether to highlight. Defaults to `true` whenever `language` is set and a highlighter resolves from the `highlighter` prop or from context. `highlight={false}` is an absolute off switch: it disables ALL highlighting — including an explicit `highlighter` prop and a context highlighter. The block renders the escaped plain `<pre><code>` fallback while keeping the `language` label. When highlighting is enabled, client-side colorization may appear after first paint, but the block keeps stable layout metrics. |
| `language` | `string` | no | — | Optional language label rendered above the code (there is no header bar); also selects the grammar for highlighting. |
| `languageLabelVisible` | `boolean` | no | — | Whether to render the language label above the code. Default `true`. Pass `false` to keep `language`-driven highlighting without the visible label; with `copyable` also unset, nothing renders above the code. |
| `lineNumbers` | `boolean` | no | `false` | Number each line of the code. The numbers are drawn in the left gutter, kept out of the copied text and out of the accessibility tree, and a wrapped line is numbered once. Defaults to `false`. |
| `scrollFadeVisible` | `boolean` | no | — | Show a scroll-driven fade on the horizontal (inline) edges of the code viewport as a long line overflows — signals "this line continues" rather than dimming a wrapped block. Opt-in and presentation-only. The gradient terminates at partial opacity (not fully opaque) so a half-covered glyph still reads as a glyph, not as a hard cutoff. Defaults to `false`. |
| `streaming` | `boolean` | no | `false` | The code is still arriving, as in a streamed reply with an open fence. A caret follows the final character, `streamingLabel` shows where the copy button will be, the copy button is withheld, and the bottom edge is dashed. Highlighting waits until it is `false`. Defaults to `false`. |
| `streamingLabel` | `string` | no | `"Writing…"` | The status shown while `streaming`. Defaults to `'Writing…'`. |
| `wrap` | `boolean` | no | `false` | Wrap a line longer than the block instead of scrolling it sideways. Defaults to `false`, which keeps the block a fixed-width box that scrolls inside itself with a visible scrollbar. |
| `annotations` | `(opaque)` | no | — | Notes drawn under specific lines, such as the line a file problem points at. Works with highlighted and plain code alike. Pass a new array to change them. Not expressible in JSON Schema; see the component types for the signature. |
| `highlighter` | `(opaque)` | no | — | Highlighter for this instance. Receives `(code, language)` and returns an HTML string (sync or async). Takes precedence over a highlighter an ancestor published through `setCodeHighlighterContext`; with neither, the block renders unhighlighted. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

- `--cinder-code-block-background`
- `--cinder-code-block-edge`
- `--cinder-code-block-font-size`
- `--cinder-code-block-height`
- `--cinder-code-block-line-height`
- `--cinder-code-block-padding`

<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
