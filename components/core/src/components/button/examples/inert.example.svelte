<script lang="ts" module>
  export const title = 'Inert buttons with a reason';
  export const description =
    'An aria-disabled button stays focusable, ignores the press and says why through aria-describedby and a tooltip. Icon-only inert buttons keep their accessible name; the live Export beside them still works.';
</script>

<script lang="ts">
  import { Button, Tooltip } from '@lostgradient/cinder';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  const uid = $props.id();
  let presses = $state(0);
</script>

<div class="example-preview-column">
  <div class="example-preview-row">
    <Button label="New chat" onclick={() => (presses += 1)} />
    <Tooltip text="Connect a provider to start a chat" describe={false}>
      <Button
        label="New chat"
        aria-disabled="true"
        aria-describedby={`${uid}-reason`}
        onclick={() => (presses += 1)}
      />
    </Tooltip>
    <span id={`${uid}-reason`} class="cinder-sr-only">Connect a provider to start a chat</span>
    <span>Presses reaching the page: {presses}</span>
  </div>
  <div class="example-preview-row">
    <Tooltip text="This agent’s plugin is disabled" describe={false}>
      <Button
        iconOnly
        variant="secondary"
        aria-label="Add a memory"
        aria-disabled="true"
        aria-describedby={`${uid}-memory-reason`}
      >
        {#snippet leadingIcon()}<Plus size={16} aria-hidden="true" />{/snippet}
      </Button>
    </Tooltip>
    <Tooltip text="This agent’s plugin is disabled" describe={false}>
      <Button
        iconOnly
        variant="ghost"
        aria-label="Edit memory"
        aria-disabled="true"
        aria-describedby={`${uid}-memory-reason`}
      >
        {#snippet leadingIcon()}<Pencil size={16} aria-hidden="true" />{/snippet}
      </Button>
    </Tooltip>
    <Tooltip text="This agent’s plugin is disabled" describe={false}>
      <Button
        iconOnly
        variant="ghost-danger"
        aria-label="Delete memory"
        aria-disabled="true"
        aria-describedby={`${uid}-memory-reason`}
      >
        {#snippet leadingIcon()}<Trash2 size={16} aria-hidden="true" />{/snippet}
      </Button>
    </Tooltip>
    <span id={`${uid}-memory-reason`} class="cinder-sr-only">This agent’s plugin is disabled</span>
    <Button label="Export" />
  </div>
</div>
