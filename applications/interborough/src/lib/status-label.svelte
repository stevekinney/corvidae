<script lang="ts">
  /**
   * A status as a person reads it: its word beside a StatusDot of the word's tone. Cinder's StatusDot
   * owns the word-to-tone table, so this passes the word and never picks a tone. The one place a
   * records page draws a status, so the word and its colour never come apart.
   */
  import { StatusDot, type StatusDotWordLabel } from '@lostgradient/cinder';

  interface Props {
    /**
     * One of the seven status words, or any word Cinder's table knows with its qualifier after a
     * comma ("Running, checking the result"), so a run page can say "Waiting" for a signal.
     */
    word: StatusDotWordLabel;
    /** A count or short phrase drawn after the word, muted and with no comma in the visible text. */
    qualifier?: string | number | undefined;
  }

  let { word, qualifier }: Props = $props();
</script>

<StatusDot {word} {...qualifier === undefined ? {} : { qualifier }} data-status-word={word} />
