<script lang="ts">
  /**
   * The options of a choice facet: a titled list of checkbox rows with a "Matches any selected"
   * footer and a Clear link, or a titled list of radio rows. The facet chip's popover and the
   * narrow form's Filter menu both draw it, so a facet reads the same in either place.
   */
  import { default as Button } from '../button/index.ts';
  import { default as Checkbox } from '../checkbox/index.ts';
  import { default as Radio } from '../_radio/index.ts';
  import { default as RadioGroup } from '../radio-group/index.ts';
  import type { ChoiceFacet, FacetOption } from './filter-bar.types.ts';

  type Props = {
    /** The facet whose options are drawn. */
    facet: ChoiceFacet;
    /** The chosen values. */
    values: readonly string[];
    /** Whether the options can be changed. */
    disabled: boolean;
    /** Id of the title, so a surrounding dialog can be named by it. */
    titleId: string;
    /** Called with every chosen value after a multiple choice facet changes. */
    onValuesChange: (values: readonly string[]) => void;
    /** Called with the chosen value after a single choice facet changes. */
    onValueChange: (value: string) => void;
    /** Whether to draw the title. The Filter menu names the section with its own row. */
    titleVisible?: boolean;
  };

  let {
    facet,
    values,
    disabled,
    titleId,
    onValuesChange,
    onValueChange,
    titleVisible = true,
  }: Props = $props();

  const generatedId = $props.id();
  const multiple = $derived(facet.multiple !== false);
  const title = $derived(facet.title ?? facet.label);
  const matchLabel = $derived(facet.matchLabel ?? 'Matches any selected');
  const groupName = $derived(`${generatedId}-${facet.key}`);

  function countId(option: FacetOption): string {
    return `${generatedId}-count-${option.value}`;
  }

  function toggle(option: FacetOption, checked: boolean): void {
    const next = checked
      ? [...values.filter((value) => value !== option.value), option.value]
      : values.filter((value) => value !== option.value);
    // Keep the facet's own option order so the chip reads "Chats, Goals" however they were ticked.
    const ordered = facet.options
      .map((candidate) => candidate.value)
      .filter((value) => next.includes(value));
    onValuesChange(ordered);
  }
</script>

<div
  class="cinder-filter-bar__options"
  data-cinder-multiple={multiple ? '' : undefined}
  data-cinder-title-hidden={titleVisible ? undefined : ''}
>
  {#if titleVisible && multiple}
    <h2 id={titleId} class="cinder-filter-bar__options-title">{title}</h2>
  {/if}

  {#if multiple}
    <div role="group" class="cinder-filter-bar__option-list" aria-labelledby={titleId}>
      {#each facet.options as option (option.value)}
        <div class="cinder-filter-bar__option">
          <Checkbox
            class="cinder-filter-bar__option-control"
            label={option.label}
            checked={values.includes(option.value)}
            disabled={disabled || facet.disabled === true || option.disabled === true}
            aria-describedby={option.count === undefined ? undefined : countId(option)}
            onValueChange={(checked) => toggle(option, checked)}
          />
          {#if option.count !== undefined}
            <span id={countId(option)} class="cinder-filter-bar__option-count">{option.count}</span>
          {/if}
        </div>
      {/each}
    </div>
    <div class="cinder-filter-bar__options-footer">
      <span class="cinder-filter-bar__options-match">{matchLabel}</span>
      <Button
        variant="ghost"
        size="sm"
        class="cinder-filter-bar__options-clear"
        disabled={disabled || facet.disabled === true || values.length === 0}
        onclick={() => onValuesChange([])}
      >
        Clear
      </Button>
    </div>
  {:else}
    <RadioGroup
      name={groupName}
      label={title}
      class="cinder-filter-bar__option-list"
      value={values[0] ?? ''}
      disabled={disabled || facet.disabled === true}
    >
      {#each facet.options as option (option.value)}
        <div class="cinder-filter-bar__option">
          <Radio
            id={`${groupName}-${option.value}`}
            value={option.value}
            label={option.label}
            {...option.disabled === true ? { disabled: true } : {}}
            aria-describedby={option.count === undefined ? undefined : countId(option)}
            onchange={() => onValueChange(option.value)}
          />
          {#if option.count !== undefined}
            <span id={countId(option)} class="cinder-filter-bar__option-count">{option.count}</span>
          {/if}
        </div>
      {/each}
    </RadioGroup>
  {/if}
</div>
