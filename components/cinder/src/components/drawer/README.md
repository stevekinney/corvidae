# Drawer

Edge-anchored overlay panel for supplementary content without leaving the current page. The `placement` prop picks the edge: `left`, `right` (default), or `bottom` for mobile-style bottom sheets. Drawer is modal by default; set `modal={false}` for a non-modal `<aside>` that leaves the page interactive while still closing from the shared Escape stack. A non-modal drawer reads as a side panel of the page: its panel is the inset surface (`--cinder-surface-inset`), and its header, body and footer are transparent, where a modal drawer is a raised sheet.

A bottom drawer is a sheet, and every sheet follows the same rules (design rows 05d, 05j):

- **Grabber**: `placement="bottom"` shows a 36 by 4 grabber above the header. It is decorative; set `dragHandleVisible={false}` to omit it. With `detents` it is the resize control instead (see Detents below).
- **Keyboard and height**: while a bottom drawer is open it rides above the on-screen keyboard (`--_cinder-keyboard-inset`, published only while it is open) and its 90dvh cap shrinks by the keyboard, so on a short viewport the body scrolls inside the sheet instead of the sheet outgrowing the screen.
- **Reduced motion**: the drawer and every sheet cross-fade instead of sliding when the person asked for less motion. The fade is played from script, because `foundation.css` forces every CSS transition and animation to 0.01ms under reduced motion.

## Detents

`detents` (a list of `DrawerDetent`: `peek`, `medium` and `large`) makes a bottom sheet rest at fixed heights, and `bind:detent` reads and sets the current one. A sheet with no `detents` is as tall as its content up to the 90dvh cap.

- **`large`** is the 90dvh cap, **`medium`** is half the viewport, and **`peek`** is a collapsed bar, a grabber band and a 56px row, that shows the sheet's title and the live `count` (a polite live region, so a screen reader hears it change). The header, body and footer step aside while the sheet peeks, and the title still names the dialog.
- **Resizing** with two or more detents: the grabber is a focusable separator (the WAI-ARIA window splitter). Drag it, or the peek bar, and the sheet follows the pointer and snaps to the nearest detent on release. ArrowUp and ArrowDown step to the next larger and smaller detent, Home and End jump to the smallest and largest, and Enter, Space or a tap steps to the next larger one, wrapping from the largest back to the smallest. Tapping the peek bar opens the sheet and moves focus to the grabber.
- **Detents belong to the bottom sheet**: `left` and `right` drawers ignore them. Under reduced motion the height change is instant.

`DrawerDetent` is exported alongside `DrawerPlacement` and `DrawerSize`.

## Footer bar and header bar

- **Footer**: the `footer` slot is a bar on the sheet's surface rather than a strip over the content. The body scrolls under a 24px fade that ends at the bar's top edge, so the call to action never floats over a row, and the bar's bottom padding keeps clear of a bottom safe area.
- **Content never shrinks**: children of the scrolling body keep their height; a body that outgrows the sheet scrolls instead of squeezing its rows.
- **Header bar**: a bottom sheet with an `action` snippet draws its default header as three columns: the close control at the start (`closeLabel="Cancel"` reads as a text button), the title centred as a 14px semibold label rather than a page heading, and `action` at the end. The DOM order stays title, close, action, so focus order is Cancel then the action.

## Choosing this component

- Showing detail or edit forms alongside a list or table where the user needs to stay in context.
- Navigation trees, filter panels, or settings that the user may want to keep open while interacting with the page.
- Secondary workflows that complement the current view rather than replacing it.
- Mobile-first surfaces that should slide up from the bottom of the viewport — use `placement="bottom"`, optionally with `dragHandleVisible`.

## Choosing something else

- Full-screen workflows that require the user's full attention — use a [`Modal`](../modal/README.md) or navigate to a new page.
- Brief contextual explanations or single-action prompts — use a [`Popover`](../popover/README.md) instead.

## Related components

- [`Modal`](../modal/README.md) — blocking full-attention overlay when the user cannot continue without acting.
- [`Sidebar`](../sidebar/README.md) — persistent side panel that is always visible (not overlaid).

## Usage

```svelte
<script lang="ts">
  import { Button } from '@lostgradient/cinder';
  import { Checkbox } from '@lostgradient/cinder';
  import { Drawer } from '@lostgradient/cinder';

  let open = $state(false);
  let triggerRef: HTMLElement | null = $state(null);

  const filters = Array.from({ length: 30 }, (_, index) => ({
    id: `drawer-overflowing-filter-${index + 1}`,
    label: `Filter group ${index + 1}`,
  }));
</script>

<Button
  label="Open drawer"
  onclick={(event: MouseEvent) => {
    triggerRef = event.currentTarget as HTMLElement;
    open = true;
  }}
/>

<Drawer bind:open title="Filters" {triggerRef}>
  <div style="display: grid; gap: 0.75rem;">
    {#each filters as filter (filter.id)}
      <Checkbox id={filter.id} label={filter.label} />
    {/each}
  </div>

  {#snippet footer()}
    <Button variant="secondary" label="Cancel" onclick={() => (open = false)} />
    <Button label="Apply" onclick={() => (open = false)} />
  {/snippet}
</Drawer>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `ariaLabelledby` | `string` | no | — | Optional id of an element that names the drawer. When supplied, drawer wires `aria-labelledby` to this id and renders no internal heading. Use this when a custom `header` snippet has its own visible heading — supply `ariaLabelledby` pointing to that heading's id so the visible and accessible names stay in sync. |
| `class` | `string` | no | — | Additional class names merged with `.cinder-drawer`. |
| `closeIconLabel` | `string` | no | `"Close drawer"` | Accessible name of the X icon close button, for a drawer that is not a generic one, such as "Close navigation" on a sidebar's drawer. |
| `closeLabel` | `string` | no | — | Words for the close control. When set, the control is a text button that reads these words ("Close", as on the shared sheets) instead of the X icon, and they are its accessible name. Left out, the control is the X icon named "Close drawer". |
| `count` | `string` | no | — | A live count the collapsed `peek` bar shows beside the title, such as "12 results". It is a polite live region, so screen readers announce it as it changes. Only the peek bar draws it. |
| `detent` | `"peek"` \| `"medium"` \| `"large"` | no | — | The detent the sheet rests at, one of `detents`. Bindable via `bind:detent`. Left out, or not one of `detents`, the sheet rests at the smallest detent. |
| `detents` | (`"peek"` \| `"medium"` \| `"large"`)[] | no | — | The heights a `placement="bottom"` drawer can rest at, from `peek`, `medium` and `large`. Listed in any order, they are used smallest first. With two or more, the grabber becomes a resize control: drag it, press ArrowUp and ArrowDown on it, or tap it, and the sheet snaps to the nearest detent. A single detent fixes the sheet at that height. Left out, the sheet is as tall as its content up to 90% of the viewport. Ignored for `left`/`right` placements. |
| `dragHandleVisible` | `boolean` | no | `true` | Whether a `placement="bottom"` drawer shows the grabber, the small pill above the header that marks it as a sheet. Swipe-to-close is not implemented, so the pill is a visual affordance only, unless the drawer has `detents`: then the grabber is the resize control and always shows. Ignored for `left`/`right` placements. Named `dragHandleVisible` (not `draggable`) to avoid colliding with the native HTML `draggable` attribute on the underlying `<dialog>`. |
| `modal` | `boolean` | no | `true` | Whether the drawer is modal. Modal drawers use the native dialog top layer, backdrop, body scroll lock, and focus trap. Non-modal drawers render as an aside and leave the page interactive. |
| `open` | `boolean` | no | — | Whether the drawer is open. Bindable via `bind:open`. |
| `placement` | `"left"` \| `"right"` \| `"bottom"` | no | `"right"` | Edge the drawer slides in from. |
| `size` | `"xs"` \| `"sm"` \| `"md"` \| `"lg"` \| `"xl"` | no | `"md"` | Drawer width token for `left`/`right` placements. Ignored for `placement="bottom"`, which always spans the full viewport width and caps its height at 90dvh. `xs` is 280px, the width of a navigation drawer; `sm` is 360px, `md` 448px, `lg` 576px and `xl` 768px. |
| `title` | `string` | yes | — | Accessible name for the drawer. Required for screen-reader labelling. Rendered as a visible `<h2>` in the default header. When a custom `header` snippet is provided without `ariaLabelledby`, this text is rendered in a visually-hidden `<h2>` as the accessible name fallback. |
| `action` | `(opaque)` | no | — | The primary action of a bottom sheet's header, such as "Apply" or "Done", drawn at the trailing edge. With it, the sheet's default header is a three-column bar: the close control at the start (a text "Cancel" when `closeLabel` says so), the title centred as a small label, and this action at the end. Ignored for `left`/`right` placements and next to a custom `header`. Not expressible in JSON Schema; see the component types for the signature. |
| `children` | `(opaque)` | yes | — | Drawer body content. Required. Not expressible in JSON Schema; see the component types for the signature. |
| `footer` | `(opaque)` | no | — | Optional footer (e.g. action buttons). Not expressible in JSON Schema; see the component types for the signature. |
| `header` | `(opaque)` | no | — | Custom header. Falls back to a default header that renders `title`. Not expressible in JSON Schema; see the component types for the signature. |
| `onExitComplete` | `(opaque)` | no | — | Called once a close has fully finished: after the modal drawer's exit transition and unmount, or as soon as a non-modal drawer closes. A consumer that wraps Drawer in its own `{#if}` clears that gate here, so the exit transition plays before the instance is destroyed. Not expressible in JSON Schema; see the component types for the signature. |
| `triggerRef` | `(opaque)` | no | — | Optional reference to the element that opened the drawer. When supplied, focus returns to this element on close. When omitted, focus restores to the element that held focus before the drawer opened. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
