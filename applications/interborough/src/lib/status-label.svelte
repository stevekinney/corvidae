<script lang="ts">
  /**
   * A status as a person reads it: its word beside a StatusDot of the word's tone
   * (`lib/status.ts`). The one place a records page draws a status, so the word and its colour never
   * come apart.
   */
  import { StatusDot } from '@lostgradient/cinder';

  import { STATUS_TONES, type StatusWord } from './status.ts';

  interface Props {
    word: StatusWord;
  }

  let { word }: Props = $props();
</script>

<StatusDot status={STATUS_TONES[word]} label={word} data-status-word={word} />
