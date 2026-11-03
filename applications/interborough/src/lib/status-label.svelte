<script lang="ts">
  /**
   * A status as a person reads it: its word beside a StatusDot of the word's tone. Cinder's StatusDot
   * owns the word-to-tone table, so this passes the word and never picks a tone. The one place a
   * records page draws a status, so the word and its colour never come apart.
   */
  import { StatusDot } from '@lostgradient/cinder';

  import type { StatusWord } from './status.ts';

  interface Props {
    word: StatusWord;
  }

  let { word }: Props = $props();
</script>

<StatusDot {word} data-status-word={word} />
