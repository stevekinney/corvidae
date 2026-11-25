<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import Chat from './chat.svelte';

  let props: Omit<ComponentProps<typeof Chat>, 'hostQuestionDocked'> = $props();
  let hostQuestionDocked = $state(false);
</script>

<output data-bound={String(hostQuestionDocked)}></output>
<Chat {...props} bind:hostQuestionDocked />
