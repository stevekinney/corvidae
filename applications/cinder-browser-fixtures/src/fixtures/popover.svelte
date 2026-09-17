<script lang="ts">
  import { Button, Popover } from '@repo/cinder';
  let accountOpen = $state(false);
  let transformedOpen = $state(false);
  let transformedTrigger: HTMLButtonElement | null = $state(null);
</script>

<section aria-label="Overview preview">
  <div id="overview-mount-basic" data-example-preview-ready="">
    <Popover
      bind:open={accountOpen}
      arrowVisible
      focusManagement="preserve"
      label="Account settings"
    >
      {#snippet trigger()}<Button
          label="Account settings"
          onclick={() => (accountOpen = !accountOpen)}
        />{/snippet}
      <p>Account settings</p>
    </Popover>
    <div style="transform: translate3d(32px, 0, 0); padding: 1rem;">
      <div
        data-testid="transformed-scroll-container"
        style="overflow: auto; width: 28rem; height: 18rem; padding: 1.5rem;"
      >
        <div style="width: 48rem; height: 30rem; padding-top: 10rem; padding-left: 12rem;">
          <button
            bind:this={transformedTrigger}
            data-testid="transformed-popover-trigger"
            onclick={() => (transformedOpen = !transformedOpen)}>Toggle anchored popover</button
          >
          <Popover
            bind:open={transformedOpen}
            triggerRef={transformedTrigger}
            placement="bottom"
            label="Transformed ancestor popover"
            class="transformed-ancestor-popover-panel"
          >
            <strong>Anchored popover</strong>
          </Popover>
        </div>
      </div>
    </div>
  </div>
</section>
