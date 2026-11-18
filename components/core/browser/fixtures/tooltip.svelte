<script lang="ts">
  import { Button, Tooltip } from '@lostgradient/cinder';

  // COR-1219: removing a focused Tooltip trigger through Svelte state (not a
  // raw DOM removal testing-library would do) is the actual repro — a native
  // `focusout` fires synchronously from INSIDE Svelte's own effect teardown as
  // the trigger's block is destroyed, and the handler's `hide()` call used to
  // land mid-teardown. Two mounts below cover both trigger-ownership modes.
  let wrappedTriggerVisible = $state(true);
  let detachedTriggerVisible = $state(true);
  let detachedTriggerElement = $state<HTMLButtonElement | null>(null);
</script>

<section aria-label="Overview preview">
  <div id="overview-mount-basic" data-example-preview-ready="">
    <Tooltip text="This is a helpful explanation."
      ><Button variant="secondary">Hover me</Button></Tooltip
    >
    <div style="transform: translate3d(32px, 0, 0); padding: 1rem;">
      <div
        data-testid="transformed-scroll-container"
        style="overflow: auto; width: 28rem; height: 18rem; padding: 1.5rem;"
      >
        <div style="width: 48rem; height: 30rem; padding-top: 10rem; padding-left: 12rem;">
          <Tooltip text="Transformed ancestor tooltip anchor" placement="bottom"
            ><span data-testid="transformed-tooltip-trigger"
              ><Button variant="secondary">Hover for anchored tooltip</Button></span
            ></Tooltip
          >
        </div>
      </div>
    </div>
  </div>
</section>

<section aria-label="Focused trigger teardown (wrapped-child)">
  <div id="teardown-wrapped-mount">
    <Tooltip text="Wrapped teardown tooltip">
      {#if wrappedTriggerVisible}
        <!-- Removed from the trigger's OWN keydown, not a separate "remove"
             button — clicking a different element would blur this one first,
             hiding the tooltip through the ordinary focusout path before any
             removal happens. The real defect (COR-1203's Send/Stop swap) has
             the focused control replaced by an unrelated state change while
             focus never left it, which this reproduces. -->
        <Button
          variant="secondary"
          data-testid="teardown-wrapped-trigger"
          onkeydown={(event) => {
            if (event.key === 'r') wrappedTriggerVisible = false;
          }}>Wrapped trigger</Button
        >
      {/if}
    </Tooltip>
  </div>
</section>

<section aria-label="Focused trigger teardown (detached)">
  <div id="teardown-detached-mount">
    {#if detachedTriggerVisible}
      <button
        type="button"
        bind:this={detachedTriggerElement}
        data-testid="teardown-detached-trigger"
        onkeydown={(event) => {
          if (event.key === 'r') detachedTriggerVisible = false;
        }}>Detached trigger</button
      >
    {/if}
    <Tooltip
      text="Detached teardown tooltip"
      triggerRef={detachedTriggerVisible ? detachedTriggerElement : null}
    />
  </div>
</section>
