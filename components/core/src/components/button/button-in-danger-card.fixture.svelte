<script lang="ts">
  import Card from '../card/card.svelte';
  import Button from './button.svelte';
</script>

<Card tone="danger" title="Danger zone">
  <Button variant="primary" label="Save changes" />
  <Button variant="secondary" label="Cancel" />
</Card>
