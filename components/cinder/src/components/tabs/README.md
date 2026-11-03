# Tabs

Composite tabs root that coordinates tab list, tab triggers, and their content panels.

## Usage

`Tabs` is a compound component. Import the parent once and compose its leaves via the namespace API: `Tabs.List`, `Tabs.Trigger`, and `Tabs.Panel`.

```svelte
<script lang="ts">
  import { Tabs } from '@lostgradient/cinder';

  let active = $state('overview');
</script>

<Tabs bind:value={active}>
  <Tabs.List label="Project sections">
    <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
    <Tabs.Trigger value="activity">Activity</Tabs.Trigger>
    <Tabs.Trigger value="settings">Settings</Tabs.Trigger>
  </Tabs.List>

  <Tabs.Panel value="overview">Project overview.</Tabs.Panel>
  <Tabs.Panel value="activity">Recent activity.</Tabs.Panel>
  <Tabs.Panel value="settings">Project settings.</Tabs.Panel>
</Tabs>
```

The leaves are also named exports of `@lostgradient/cinder`.

## Narrow collapse

Below `collapseBelow` (640px by default) a horizontal tab bar becomes one full-width select reading "Tab: Access", so a phone shows a single control instead of a bar that scrolls sideways. Picking an option selects its tab. The tab bar is hidden, not removed, so every tab still registers and every panel keeps its name. Each option's label is the tab's own text (without its count pill, which becomes the option's note); pass `label` on a trigger when the text changes after the first render. `collapseLabel` words the select's name and the prefix before its value, and `collapseBelow={false}` keeps the bar at every width. Vertical tabs never collapse.

## Caller-owned panels

Use `Tabs.Panel` for ordinary tabs where each trigger owns one rendered panel. When the selected value controls one stable external surface, pass that panel id through `Tabs.Trigger`'s `controls` prop and render the panel yourself:

```svelte
<script lang="ts">
  import { Tabs } from '@lostgradient/cinder';

  let active = $state('index.ts');
  const tabIds: Record<string, string> = {
    'index.ts': 'editor-tab-index',
    'app.svelte': 'editor-tab-app',
  };
</script>

<Tabs bind:value={active}>
  <Tabs.List label="Editor files">
    <Tabs.Trigger id={tabIds['index.ts']} value="index.ts" controls="editor-panel">
      index.ts
    </Tabs.Trigger>
    <Tabs.Trigger id={tabIds['app.svelte']} value="app.svelte" controls="editor-panel">
      app.svelte
    </Tabs.Trigger>
  </Tabs.List>
</Tabs>

<div id="editor-panel" role="tabpanel" aria-labelledby={tabIds[active]} tabindex="0">
  {active}
</div>
```

This keeps Cinder in charge of roving tabindex, activation, disabled state, and tab styling while the caller owns an imperative or stateful panel element. Give the tabs explicit ids so the external panel can label itself with the active tab.

## Trailing badges and counts

Each `Tabs.Trigger` accepts a `trailing` snippet for badges, counts, or status dots. Render the library `Badge` inside it for idiomatic styling — there is no separate badge class to learn:

```svelte
<script lang="ts">
  import { Badge } from '@lostgradient/cinder';
</script>

<Tabs.Trigger value="inbox">
  Inbox
  {#snippet trailing()}
    <Badge>3</Badge>
  {/snippet}
</Tabs.Trigger>
```

The `trailing` wrapper is `aria-hidden`, so its content is omitted from the tab's accessible name. Any count that carries meaning must therefore also live in the tab's visible `children` (the accessible name) — never rely on the trailing badge alone to convey it.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `activateOnFocus` | `boolean` | no | — | When true (default for horizontal), focusing a tab also activates it (the panel updates immediately). Vertical defaults to manual activation — the user moves focus with arrows, then presses Enter or Space. |
| `class` | `string` | no | — | Additional class names merged with `.cinder-tabs`. |
| `collapseBelow` | `string` \| `false` | no | — | Viewport width below which a horizontal tab bar collapses to a select reading "Tab: Access", so a phone shows one full-width control instead of a bar that scrolls sideways. The tabs stay in the page, hidden, and the panels keep their names. A simple CSS length such as `'640px'`, or `false` to always show the tab bar. Vertical tabs never collapse. Default `'640px'`. |
| `collapseLabel` | `string` | no | — | The select's accessible name and the prefix before the current tab's label in its trigger. Default `"Tab"`. |
| `fill` | `boolean` | no | `false` | Fill the available space when Tabs is placed inside a bounded flex parent, letting the active TabPanel occupy the remaining height. |
| `orientation` | `"horizontal"` \| `"vertical"` | no | `"horizontal"` | Layout orientation. Affects which arrow keys move between tabs. |
| `value` | `string` | no | — | Bound active tab value. |
| `children` | `(opaque)` | yes | — | Tab and TabPanel children. Not expressible in JSON Schema; see the component types for the signature. |
| `onValueChange` | `(opaque)` | no | — | Notify after the bindable value has been committed. Not expressible in JSON Schema; see the component types for the signature. |
| `onValueChangeRequest` | `(opaque)` | no | — | Intercept a proposed tab value before the bindable value is written. Return a replacement value to transform it. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

- `Tabs.List` — the tablist container; see [`tab-list`](../tab-list/README.md).
- `Tabs.Trigger` — an individual tab; see [`tab`](../tab/README.md).
- `Tabs.Panel` — a panel rendered when the matching trigger is active; see [`tab-panel`](../tab-panel/README.md).

<!-- generated:subcomponents:end -->
