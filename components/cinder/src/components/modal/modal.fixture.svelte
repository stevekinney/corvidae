<script lang="ts">
  import { Modal } from './index.ts';
  import { Popover } from '../popover/index.ts';
  import { untrack } from 'svelte';

  type FixtureProps = {
    describedById?: string;
    open?: boolean;
    anchoredOverlay?: boolean;
    title?: string;
    /** Opens the modal as a bottom sheet below this viewport width, as `sheetBelow` does. */
    sheetBelow?: string | false;
  };

  let {
    describedById,
    open = true,
    anchoredOverlay = false,
    title = 'Fixture dialog',
    sheetBelow = false,
  }: FixtureProps = $props();
  let modalOpen = $state(untrack(() => open));
  let overlayOpen = $state(untrack(() => anchoredOverlay));
  let triggerRef: HTMLButtonElement | null = $state(null);
  let overlayTriggerRef: HTMLButtonElement | null = $state(null);
  // This scenario stays out of the default fixture so its snapshots and assertions remain stable.
  const keyboardScroll =
    new URLSearchParams(globalThis.location.search).get('keyboardScroll') === '1';
  const keyboardScrollParagraphs = Array.from(
    { length: 48 },
    (_, index) => `Keyboard-scroll body paragraph ${index + 1}.`,
  );
</script>

<div class="modal-fixture">
  <button bind:this={triggerRef} class="modal-fixture__trigger" type="button">
    Open fixture modal
  </button>

  {#if describedById}
    <Modal bind:open={modalOpen} {title} {triggerRef} {describedById} {sheetBelow}>
      {#if keyboardScroll}
        {#each keyboardScrollParagraphs as paragraph (paragraph)}
          <p>{paragraph}</p>
        {/each}
      {:else}
        <p id={describedById}>
          This dialog includes a description so aria-describedby can be captured in the visual
          fixture.
        </p>
      {/if}

      {#snippet footer()}
        {#if anchoredOverlay}
          <Popover
            bind:open={overlayOpen}
            triggerRef={overlayTriggerRef}
            placement="bottom"
            label="Dialog-owned anchored overlay"
            focusManagement="preserve"
          >
            {#snippet trigger()}
              <button bind:this={overlayTriggerRef} class="modal-fixture__action" type="button">
                Anchored overlay trigger
              </button>
            {/snippet}

            <div class="modal-fixture__overlay-content">
              Dialog-owned overlay content remains visible beyond the panel boundary.
            </div>
          </Popover>
        {/if}
        <button class="modal-fixture__action" type="button" onclick={() => (modalOpen = false)}>
          Cancel
        </button>
        <button
          class="modal-fixture__action modal-fixture__action--primary"
          type="button"
          onclick={() => (modalOpen = false)}
        >
          Save changes
        </button>
      {/snippet}
    </Modal>
  {:else}
    <Modal bind:open={modalOpen} {title} {triggerRef} {sheetBelow}>
      {#if keyboardScroll}
        {#each keyboardScrollParagraphs as paragraph (paragraph)}
          <p>{paragraph}</p>
        {/each}
      {:else}
        <p>This dialog body is supplied by the host fixture.</p>
      {/if}

      {#snippet footer()}
        {#if anchoredOverlay}
          <Popover
            bind:open={overlayOpen}
            triggerRef={overlayTriggerRef}
            placement="bottom"
            label="Dialog-owned anchored overlay"
            focusManagement="preserve"
          >
            {#snippet trigger()}
              <button bind:this={overlayTriggerRef} class="modal-fixture__action" type="button">
                Anchored overlay trigger
              </button>
            {/snippet}

            <div class="modal-fixture__overlay-content">
              Dialog-owned overlay content remains visible beyond the panel boundary.
            </div>
          </Popover>
        {/if}
        <button class="modal-fixture__action" type="button" onclick={() => (modalOpen = false)}>
          Cancel
        </button>
        <button
          class="modal-fixture__action modal-fixture__action--primary"
          type="button"
          onclick={() => (modalOpen = false)}
        >
          Save changes
        </button>
      {/snippet}
    </Modal>
  {/if}
</div>

<style>
  .modal-fixture {
    display: grid;
    min-block-size: 12rem;
    place-items: start;
  }

  .modal-fixture__trigger {
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-sm);
    background: var(--cinder-surface);
    color: var(--cinder-text-default);
    font: inherit;
    padding: var(--cinder-space-2) var(--cinder-space-3);
  }

  .modal-fixture__action {
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-sm);
    background: var(--cinder-surface);
    color: var(--cinder-text-default);
    font: inherit;
    padding: var(--cinder-space-2) var(--cinder-space-3);
  }

  .modal-fixture__action--primary {
    background: var(--cinder-accent-solid);
    color: var(--cinder-accent-contrast);
  }

  .modal-fixture__overlay-content {
    min-width: 18rem;
    max-width: 24rem;
    padding: var(--cinder-space-4);
  }
</style>
