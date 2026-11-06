# PageHeader

Page-level heading with named title, description, breadcrumb, and action regions.

## Usage

```svelte
<script lang="ts">
  import { PageHeader } from '@lostgradient/cinder';
</script>

<PageHeader title="Approvals" />
```

## Create action, status and errors

A list page's create action is a `createAction`: a secondary icon-only "+" with a tooltip and an accessible name, drawn last in the actions region so it sits in the same place in every state, whether the list is empty or not. It is always secondary, because an empty state's own button is the only primary on an empty page. It goes inert under a stale `<StaleRegion>` (`mutating` defaults to `true`).

```svelte
<script lang="ts">
  import { PageHeader } from '@lostgradient/cinder';
</script>

<PageHeader
  title="Agents"
  description="Agents run your chats, goals and schedules."
  createAction={{ label: 'New agent', href: '/agents/new' }}
/>
```

While a full-page `ErrorState` shows under the header, pass `error` so the header's primary buttons draw as secondary and Try again is the only primary.

`status` takes the page's status as a snippet and `statusPlacement` puts it beside the title (`inline`, on its first line) or under it (`below`, the default). The title wraps to two lines and then ends in an ellipsis; its tooltip carries the full text, from `title` or, when `title` is a snippet, from `titleText`.

## Flush

`flush` draws the header with no rule under it and no padding around it, so its title lines up with the content beneath. Use it where the page lays out its own column, such as a page of settings with a section navigation beside it; a header across the top of a page keeps its rule.

```svelte
<script lang="ts">
  import { PageHeader } from '@lostgradient/cinder';
</script>

<PageHeader flush title="Allowed models" description="Which models agents may use." />
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-page-header`. |
| `description` | `string` | no | — | Optional supporting text rendered below the title; the runtime API also accepts a template-only snippet. |
| `error` | `boolean` | no | `false` | A full-page error state shows under this header, so its primary buttons draw as secondary. |
| `flush` | `boolean` | no | `false` | Draws the header with no rule under it and no padding around it, so its title lines up with the content beneath it. A page that lays out its own column, such as a page of settings with a section navigation beside it, uses this; a header across the top of a page keeps its rule. |
| `headingLevel` | `1` \| `2` \| `3` \| `4` \| `5` \| `6` | no | `1` | Heading level for the title element. Defaults to `1`. |
| `statusPlacement` | `"inline"` \| `"below"` | no | `"below"` | Where `status` sits: `inline` beside the title on its first line, or `below` the title. |
| `title` | `string` | yes | — | Page-level heading text rendered inside the `headingLevel` heading; the runtime API also accepts a template-only snippet. |
| `titleText` | `string` | no | — | The title's plain text, for the full-title tooltip when `title` is a snippet. |
| `actions` | `(opaque)` | no | — | Optional trailing actions (buttons, menus, controls). Not expressible in JSON Schema; see the component types for the signature. |
| `breadcrumbs` | `(opaque)` | no | — | Optional breadcrumb navigation rendered above the heading row. Not expressible in JSON Schema; see the component types for the signature. |
| `status` | `(opaque)` | no | — | The page's status, such as a dot and "Waiting on you". It is a snippet so the page owns the words and the tone; see `statusPlacement` for where it sits. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
