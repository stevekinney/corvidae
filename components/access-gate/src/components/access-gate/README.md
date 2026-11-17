# AccessGate

Authorization presentation gate for controls and sections that stay visible when the current user is missing an application scope or permission.

## Usage

```svelte
<script lang="ts">
  import { AccessGate } from '@lostgradient/cinder';
  import { Button } from '@lostgradient/cinder';
</script>

<AccessGate granted={false} reason="Requires scope: workflows:cancel">
  <Button label="Cancel workflow" />
</AccessGate>

<AccessGate
  granted={false}
  variant="section"
  reason="Requires scope: storage:admin"
  requirement="storage:admin"
/>
```

A denied section is a neutral disc with a lock, a title in the person's words, the reason, the missing scope small and monospaced on its own line ("requires hooks:read"), and an `actions` snippet. It has two layouts. `layout="inline"` (the default) is a compact bordered card that replaces one region while the rest of the page stays readable. `layout="page"` has no card, grows the disc to 48px and centres in the region it fills, for a page with nothing readable; give it `headingLevel={1}`. A gate has no primary action: give its actions the secondary button variant.

```svelte
<script lang="ts">
  import { AccessGate, Button } from '@lostgradient/cinder';
</script>

<AccessGate
  granted={false}
  variant="section"
  layout="page"
  headingLevel={1}
  title="Your sign-in can't open Hooks"
  reason="Settings › API reference › Your scopes shows what it can do."
  requirement="hooks:read"
>
  {#snippet actions()}
    <Button variant="secondary" label="See your scopes" />
    <Button variant="secondary" label="Back to Home" />
  {/snippet}
</AccessGate>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with the denied-state wrapper or section placeholder. |
| `granted` | `boolean` | yes | — | Whether the consumer-authorized action or section is available. |
| `headingLevel` | `1` \| `2` \| `3` \| `4` \| `5` \| `6` | no | `3` | Heading level of the section title. |
| `layout` | `"inline"` \| `"page"` | no | `"inline"` | Layout of a denied `'section'` gate. Ignored by the inline variant. |
| `reason` | `string` | yes | — | Human-readable explanation shown to users and wired to assistive technology. |
| `requirement` | `string` | no | — | Named scope, permission, or policy requirement. A section gate shows it small and monospaced on its own line, as "requires <requirement>". |
| `title` | `string` | no | `"Section locked"` | Heading of a denied `'section'` gate, in the person's words, such as "Your sign-in can't open Hooks". Ignored by the inline variant. |
| `variant` | `"inline"` \| `"section"` | no | `"inline"` | Presentation mode. |
| `actions` | `(opaque)` | no | — | Actions rendered under a denied `'section'` gate, such as "See your scopes" or "Back to Home". Give them the secondary button variant: a gate has no primary action. Not expressible in JSON Schema; see the component types for the signature. |
| `children` | `(opaque)` | no | — | Gated content. Rendered untouched when access is granted. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
