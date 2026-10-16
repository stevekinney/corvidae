<script lang="ts">
  /*
   * The numeric channel controls of the color editor (COR-263): one labeled field per channel
   * of the authored color space, plus alpha. They edit the same authored value the text field
   * and the picker edit, in the space the color is authored in. Each field is a ParameterField
   * whose base is the shipped channel, so a changed channel names its shipped value and can be
   * reset to it. Fields are plain text with decimal input mode: a number input would snap or
   * clamp, and a channel beyond 0–1 is a legitimate wide-gamut value, not an error.
   */
  import { Input, ParameterField } from '@lostgradient/cinder';

  import {
    colorAlpha,
    spaceDefinition,
    withAlpha,
    withChannel,
    type DtcgColor,
  } from './theme-color-model.ts';

  type Props = {
    color: DtcgColor;
    /** The shipped color; its channels are the bases when it is authored in the same space. */
    shipped: DtcgColor | null;
    /** Names every field: the token path and the context. */
    subject: string;
    idPrefix: string;
    onChange: (color: DtcgColor) => void;
  };
  let { color, shipped, subject, idPrefix, onChange }: Props = $props();

  const definition = $derived(spaceDefinition(color.colorSpace));
  const sameSpace = $derived(shipped !== null && shipped.colorSpace === color.colorSpace);
  // Text the user is typing, kept until it parses to the committed number so "0." survives.
  let typed = $state<Record<string, string>>({});

  function shownText(key: string, value: number | 'none' | undefined): string {
    const draft = typed[key];
    if (draft !== undefined && Number(draft) === value) return draft;
    return value === undefined ? '' : String(value);
  }

  function edit(key: string, text: string, apply: (value: number) => void): void {
    typed = { ...typed, [key]: text };
    const value = Number(text);
    if (text.trim() !== '' && Number.isFinite(value)) apply(value);
  }

  const baseOf = (index: 0 | 1 | 2): number => {
    const part = (sameSpace ? shipped : color)?.components[index];
    return typeof part === 'number' ? part : 0;
  };
  const currentOf = (index: 0 | 1 | 2): number => {
    const part = color.components[index];
    return typeof part === 'number' ? part : 0;
  };
</script>

{#if definition !== undefined}
  <div class="channels" role="group" aria-label={`Channels of ${subject}`}>
    {#each definition.channels as channel, position (channel.key)}
      {@const index = position as 0 | 1 | 2}
      {@const id = `${idPrefix}-${channel.key}`}
      <ParameterField
        {id}
        label={channel.label}
        base={baseOf(index)}
        override={sameSpace && currentOf(index) !== baseOf(index) ? currentOf(index) : undefined}
        onOverrideChange={(next) => onChange(withChannel(color, index, next ?? baseOf(index)))}
      >
        {#snippet children()}
          <Input
            id={`${id}-input`}
            label={`${channel.label} of ${subject}`}
            labelVisible={false}
            inputmode="decimal"
            autocomplete="off"
            value={shownText(channel.key, color.components[index])}
            onValueChange={(text) =>
              edit(channel.key, text, (value) => onChange(withChannel(color, index, value)))}
          />
        {/snippet}
      </ParameterField>
    {/each}
    <ParameterField
      id={`${idPrefix}-alpha`}
      label="Alpha"
      base={sameSpace ? colorAlpha(shipped!) : 1}
      override={colorAlpha(color) !== (sameSpace ? colorAlpha(shipped!) : 1)
        ? colorAlpha(color)
        : undefined}
      onOverrideChange={(next) =>
        onChange(withAlpha(color, next ?? (sameSpace ? colorAlpha(shipped!) : 1)))}
    >
      {#snippet children()}
        <Input
          id={`${idPrefix}-alpha-input`}
          label={`Alpha of ${subject}`}
          labelVisible={false}
          inputmode="decimal"
          autocomplete="off"
          value={shownText('alpha', colorAlpha(color))}
          onValueChange={(text) =>
            edit('alpha', text, (value) =>
              onChange(withAlpha(color, Math.min(1, Math.max(0, value)))),
            )}
        />
      {/snippet}
    </ParameterField>
  </div>
{/if}

<style>
  .channels {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 12px;
  }
</style>
