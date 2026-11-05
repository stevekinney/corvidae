<script lang="ts">
  import Input from '../input/input.svelte';
  import { formatClockTime, parseClockText } from './schedule-builder.utilities.ts';

  /**
   * The At field: a time of day written the way the Runs panel reads it back, such as `9:00 AM`,
   * not the browser's own time control, whose hour is zero-padded and which draws a clock glyph.
   * Typing is free text; leaving the field or pressing Enter reads it, and anything that is not a
   * time puts the last good time back instead of silently becoming midnight.
   */
  let {
    id,
    value,
    onTimeChange,
  }: {
    /** Id of the text input. */
    id: string;
    /** The time as `HH:MM` on a 24-hour clock. */
    value: string;
    /** Called with the new `HH:MM` time once a typed time has been read. */
    onTimeChange: (time: string) => void;
  } = $props();

  let typed = $state<string | undefined>(undefined);
  const shown = $derived(typed ?? formatClockTime(value));

  function commit(event: Event): void {
    const field = event.currentTarget as HTMLInputElement;
    const next = parseClockText(field.value, value);
    typed = undefined;
    const kept = next ?? value;
    field.value = formatClockTime(kept);
    if (next !== undefined && next !== value) onTimeChange(next);
  }
</script>

<Input
  {id}
  label="At"
  type="text"
  value={shown}
  autocomplete="off"
  spellcheck={false}
  oninput={(event) => (typed = (event.currentTarget as HTMLInputElement).value)}
  onchange={commit}
  onkeydown={(event) => {
    if (event.key === 'Enter') commit(event);
  }}
/>
