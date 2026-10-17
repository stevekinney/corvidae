# Text

A run of text in one of the typography variants `h1` to `h5`, `caption`, and `body`. Color is inherited from the container.

## Usage

```svelte
<script lang="ts">
  import { Text } from '@lostgradient/cinder';
</script>

<Text variant="h2">Release notes</Text>
<Text>Body text renders a paragraph.</Text>
<Text variant="h1" as="h2">Styled as h1, rendered as h2</Text>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `as` | `"object"` \| `"h1"` \| `"h2"` \| `"h3"` \| `"h4"` \| `"h5"` \| `"caption"` \| `"body"` \| `"a"` \| `"abbr"` \| `"address"` \| `"article"` \| `"aside"` \| `"audio"` \| `"b"` \| `"bdi"` \| `"bdo"` \| `"blockquote"` \| `"button"` \| `"canvas"` \| `"cite"` \| `"code"` \| `"colgroup"` \| `"data"` \| `"datalist"` \| `"dd"` \| `"del"` \| `"details"` \| `"dfn"` \| `"dialog"` \| `"div"` \| `"dl"` \| `"dt"` \| `"em"` \| `"fieldset"` \| `"figcaption"` \| `"figure"` \| `"footer"` \| `"form"` \| `"h6"` \| `"head"` \| `"header"` \| `"hgroup"` \| `"html"` \| `"i"` \| `"iframe"` \| `"ins"` \| `"kbd"` \| `"label"` \| `"legend"` \| `"li"` \| `"main"` \| `"map"` \| `"mark"` \| `"menu"` \| `"meter"` \| `"nav"` \| `"noscript"` \| `"ol"` \| `"optgroup"` \| `"option"` \| `"output"` \| `"p"` \| `"picture"` \| `"pre"` \| `"progress"` \| `"q"` \| `"rp"` \| `"rt"` \| `"ruby"` \| `"s"` \| `"samp"` \| `"script"` \| `"search"` \| `"section"` \| `"select"` \| `"slot"` \| `"small"` \| `"span"` \| `"strong"` \| `"style"` \| `"sub"` \| `"summary"` \| `"sup"` \| `"table"` \| `"tbody"` \| `"td"` \| `"template"` \| `"textarea"` \| `"tfoot"` \| `"th"` \| `"thead"` \| `"time"` \| `"title"` \| `"tr"` \| `"u"` \| `"ul"` \| `"var"` \| `"video"` | no | — | Element tag that overrides the variant's default element. |
| `class` | `string` | no | — | Additional classes merged onto the root element. |
| `variant` | `"h1"` \| `"h2"` \| `"h3"` \| `"h4"` \| `"h5"` \| `"caption"` \| `"body"` | no | `"body"` | Typography variant. Headings render `h1` to `h5`; `caption` and `body` render paragraphs. |
| `children` | `(opaque)` | yes | — | Required text content. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
