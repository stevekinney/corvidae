# AppBar

<!-- generated:a11y-record:required -->

`AppBar` is a sticky top bar of translucent material for a page: Back and any leading content, the page's title, and trailing icon actions. It is 56px tall and draws no rule. Its surface is the canvas mixed at 82% with a 16px backdrop blur, so what scrolls under it shows through softly, and it is opaque where the platform cannot blur or when the person asks for less transparency. It is not a [`Toolbar`](../toolbar/README.md), which is the WAI-ARIA control group with arrow-key navigation, and not a [`NavigationBar`](../navigation-bar/README.md), which is a bar of navigation items.

## Usage

```svelte
<script lang="ts">
  import { AppBar } from '@lostgradient/cinder';
  import Share from '@lucide/svelte/icons/share';
  import Star from '@lucide/svelte/icons/star';
</script>

{#snippet shareIcon()}<Share class="cinder-icon-md" aria-hidden="true" />{/snippet}
{#snippet saveIcon()}<Star class="cinder-icon-md" aria-hidden="true" />{/snippet}

<AppBar
  title="Death & Co"
  headingLevel={1}
  back={{ href: '/places' }}
  actions={[
    { label: 'Share', icon: shareIcon, onclick: () => {} },
    { label: 'Save', icon: saveIcon, onclick: () => {} },
  ]}
/>
```

## A phone detail page

On a phone detail page the page's identity lives in the bar: Back, the title at 20px bold, then the icon actions, pinned while the page scrolls. Give the title a `headingLevel` so it is the page's heading, and draw no separate title under the bar, so there is never an empty bar above a title of its own.

Each action in `actions` is icon-only, so its `label` is required: it is the action's accessible name and its tooltip. Under a coarse pointer every icon action, Back included, has a 44px target. `leading` and `trailing` hold anything else, such as a SegmentedControl; trailing content sits before the icon actions.

## With a large page title

Paired with a `PageHeader` in its large variant, the bar shows the title only once the large title has scrolled away. Bind the header's `collapsed` to the bar's `titleVisible`, and turn off the header's own sticky bar with `collapsedBar={false}`. The PageHeader keeps the page's heading, so leave `headingLevel` unset; while the title is hidden it is also hidden from assistive technology.

```svelte
<script lang="ts">
  import { AppBar, PageHeader } from '@lostgradient/cinder';

  let collapsed = $state(false);
</script>

<AppBar title="Runs" titleVisible={collapsed} back={{ href: '/' }} />
<PageHeader variant="large" title="Runs" bind:collapsed collapsedBar={false} />
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-app-bar`. |
| `headingLevel` | `1` \| `2` \| `3` \| `4` \| `5` \| `6` | no | — | Makes the title the page's heading at this level, for a page whose identity lives in the bar. Leave it unset when a PageHeader carries the page's heading. |
| `title` | `string` | no | — | The page's title, 20px bold on one line that ends in an ellipsis; the runtime API also accepts a template-only snippet. |
| `titleVisible` | `boolean` | no | `true` | Draws the title. Bind a large PageHeader's `collapsed` here so the title appears once the large title scrolls away; while it is hidden the title is also hidden from assistive technology. |
| `leading` | `(opaque)` | no | — | Content at the start of the bar, after Back. Not expressible in JSON Schema; see the component types for the signature. |
| `trailing` | `(opaque)` | no | — | Content at the end of the bar, before the icon actions. Not expressible in JSON Schema; see the component types for the signature. |

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
