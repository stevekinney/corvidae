# Markdown

<!-- generated:a11y-record:required -->

`Markdown` renders Markdown source as formatted content. By default it renders synchronously, so in a browser the formatted result is there on first mount (`data-state="rendered"`), and dollar signs stay literal: "Refunds of $25–$100 need approval" is a price range, not math. On the server it emits the escaped text, and the client replaces it on hydration.

Set `math` to render `$…$` and `$$…$$` as KaTeX. The math renderer loads `@lostgradient/markdown` after first paint, so the raw text shows first (`data-state="pending"`, with the source's line breaks kept) and the formatted result replaces it (`data-state="rendered"`). A caller that selects text, or a test that reads the result, waits for `rendered`.

With `math`, streamed content stays on screen: while `content` only grows, the last formatted render remains visible until the newest one lands, and a slower earlier render never replaces a newer one. Replacing the content, or changing `images` or `links`, drops straight back to the escaped plain text until the new render lands. Fenced code renders as a copyable `CodeBlock`, Mermaid as a `CodeBlock`, and a table inside a scroller that cues and names the hidden columns when the table overflows.

Set `images` or `links` to `false` for content you do not trust: each image becomes its alt text and each link its text, so nothing is fetched and nothing navigates. Each code block, table or Mermaid diagram sits in a wrapper with `data-cinder-markdown-node` set to its kind; style that attribute to lay blocks out. Pass `markdownNode` to replace how any of them renders, calling its second argument to draw the default markup inside the override.

## Usage

```svelte
<script lang="ts">
  import { Markdown } from '@lostgradient/cinder';

  const content = `## Release notes

The **nightly digest** now runs at _6 a.m._`;
</script>

<Markdown {content} />
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-markdown-content`. |
| `content` | `string` | yes | — | The Markdown source. Without `math` it renders at once in a browser; with `math` the raw text shows until the renderer has loaded, then the formatted result replaces it. |
| `images` | `boolean` | no | — | `false` renders each image as its alt text, so the content loads nothing. Default `true`. |
| `links` | `boolean` | no | — | `false` renders each link as its text, so the content navigates nowhere. Default `true`. |
| `math` | `boolean` | no | — | `true` loads the math renderer lazily, so `$…$` and `$$…$$` render as KaTeX, and the formatted result replaces the raw text after first paint. Default `false`: the Markdown renders synchronously on first mount and dollar signs stay literal, so "$25–$100" is a price range. |
| `markdownNode` | `(opaque)` | no | — | Replaces how each code block, table or Mermaid diagram renders. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## Authoring checklist

<!-- generated:authoring:start -->
<!-- generated:authoring:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
