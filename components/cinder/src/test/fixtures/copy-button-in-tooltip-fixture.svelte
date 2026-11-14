<script lang="ts">
  import CopyButton from '../../components/copy-button/copy-button.svelte';
  import Tooltip from '../../components/tooltip/tooltip.svelte';
</script>

<Tooltip text="Copy this message" placement="bottom" describe={false}>
  <CopyButton value="hello" label="Copy message" />
</Tooltip>
