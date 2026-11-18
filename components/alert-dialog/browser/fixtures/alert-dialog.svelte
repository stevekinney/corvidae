<script lang="ts">
  import { default as AlertDialog } from '@lostgradient/alert-dialog/components/alert-dialog/index.ts';
  import { default as Button } from '@lostgradient/button/components/button/index.ts';

  let open = $state(false);
</script>

<Button onclick={() => (open = true)}>Open alert dialog</Button>

<AlertDialog
  bind:open
  title="Session requires attention"
  description="Review this message before continuing. Escape and backdrop clicks intentionally keep the dialog open."
  acknowledgeLabel="I understand"
  onAcknowledge={() => {}}
/>
