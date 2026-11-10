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

## Clamping a long run

`clamp` holds the text to that many lines so a long reply keeps the shape of the page. A "Show all" button appears on the line under it only while the text is actually cut off, and opens the rest in place (it reads "Show less" while open). `expanded` is bindable. `actions` puts a page's own link on the same line, after a middle dot, such as "Show raw payloads".

```svelte
<script lang="ts">
  import { Text } from '@lostgradient/cinder';

  let { reply }: { reply: string } = $props();
</script>

<Text clamp={5}>
  {reply}
  {#snippet actions()}
    <a href="#raw">Show raw payloads</a>
  {/snippet}
</Text>
```

## Cutting an identifier in the middle

`truncate="middle"` keeps the end of a long identifier visible, because the end is what tells one from another: "payments-worker-eu-w…3a68". It takes the plain string as `text` (so it has no children), keeps the last `tailLength` characters (4 by default), and gives the head an ellipsis only when the line is too narrow, and measures the cut so the ellipsis sits against the tail with no gap. The full text is a Cinder tooltip unless `title` is set, and the cut text takes focus, so a keyboard or touch user can reach the whole value too. The whole string stays in the DOM for assistive technology and copying.

```svelte
<script lang="ts">
  import { Text } from '@lostgradient/cinder';
</script>

<Text truncate="middle" text="payments-worker-eu-west-1b-7f3a9c2e-4d81-4b06-a9e2-1c5d0f7b3a68" />
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `as` | `"object"` \| `"h1"` \| `"h2"` \| `"h3"` \| `"h4"` \| `"h5"` \| `"caption"` \| `"a"` \| `"abbr"` \| `"address"` \| `"article"` \| `"aside"` \| `"audio"` \| `"b"` \| `"bdi"` \| `"bdo"` \| `"blockquote"` \| `"button"` \| `"canvas"` \| `"cite"` \| `"code"` \| `"data"` \| `"datalist"` \| `"dd"` \| `"del"` \| `"details"` \| `"dfn"` \| `"dialog"` \| `"div"` \| `"dl"` \| `"dt"` \| `"em"` \| `"fieldset"` \| `"figcaption"` \| `"figure"` \| `"footer"` \| `"form"` \| `"h6"` \| `"header"` \| `"hgroup"` \| `"i"` \| `"iframe"` \| `"ins"` \| `"kbd"` \| `"label"` \| `"legend"` \| `"li"` \| `"main"` \| `"map"` \| `"mark"` \| `"menu"` \| `"meter"` \| `"nav"` \| `"ol"` \| `"output"` \| `"p"` \| `"picture"` \| `"pre"` \| `"progress"` \| `"q"` \| `"rp"` \| `"rt"` \| `"ruby"` \| `"s"` \| `"samp"` \| `"search"` \| `"section"` \| `"select"` \| `"slot"` \| `"small"` \| `"span"` \| `"strong"` \| `"sub"` \| `"summary"` \| `"sup"` \| `"table"` \| `"tbody"` \| `"td"` \| `"template"` \| `"textarea"` \| `"tfoot"` \| `"th"` \| `"thead"` \| `"time"` \| `"tr"` \| `"u"` \| `"ul"` \| `"var"` \| `"video"` | no | — | Element tag that overrides the variant's default element. |
| `clamp` | `number` | no | — | Holds the text to this many lines; a "Show all" button appears only while the text is cut off. |
| `class` | `string` | no | — | Additional classes merged onto the root element. |
| `expanded` | `boolean` | no | `false` | Whether a clamped run is open to its full length. |
| `tailLength` | `number` | no | `4` | With `truncate="middle"`, how many characters at the end of the text stay visible. |
| `text` | `string` | no | — | The plain text to cut in the middle with `truncate="middle"`. |
| `truncate` | `"middle"` | no | — | Cuts the text in the middle when it is too long for one line. Needs `text`. |
| `variant` | `"display"` \| `"h1"` \| `"h2"` \| `"h3"` \| `"h4"` \| `"h5"` \| `"caption"` \| `"body"` | no | `"body"` | Typography variant. Headings render `h1` to `h5`, and `display` renders an `h1`; `caption` and `body` render paragraphs. |
| `actions` | `(opaque)` | no | — | Content that sits beside the "Show all" button on the line under a clamped run, separated from it by a middle dot, such as a "Show raw payloads" link. Ignored without `clamp`. Not expressible in JSON Schema; see the component types for the signature. |
| `children` | `(opaque)` | no | — | Required text content. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
