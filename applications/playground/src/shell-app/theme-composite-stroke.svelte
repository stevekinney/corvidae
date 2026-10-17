<script lang="ts">
  /*
   * The strokeStyle fields (COR-488): a named style, or the structured form with an ordered
   * dash array and a line cap. The dash array has Move up, Move down and Remove on every row.
   * Switching between the two forms is explicit and keeps what the other form held, so a
   * switch back restores it.
   */
  import { Button, Select } from '@lostgradient/cinder';

  import ThemeCompositeMember from './theme-composite-member.svelte';
  import {
    DASH_SPEC,
    LINE_CAPS,
    moved,
    STROKE_KEYWORDS,
    type Member,
    type StrokeFields,
  } from './theme-composite-values.ts';
  import type { FieldErrors } from './theme-foundation-values.ts';
  import ThemeReorderControls from './theme-reorder-controls.svelte';

  type Props = {
    stroke: StrokeFields;
    at: string;
    errors: FieldErrors;
    idBase: string;
    subject: string;
    disabled: boolean;
    onchange: (next: StrokeFields) => void;
    /** The literal that stands in for a reference member when the author replaces it. */
    literalFor: (member: Member) => Member;
    announce: (message: string) => void;
    onenter: () => void;
  };
  let {
    stroke,
    at,
    errors,
    idBase,
    subject,
    disabled,
    onchange,
    literalFor,
    announce,
    onenter,
  }: Props = $props();

  const structured = $derived(stroke.named === null);

  const setDash = (dash: Member[]): void => onchange({ ...stroke, dash });

  function switchForm(form: string): void {
    if (form === 'named') {
      onchange({ ...stroke, named: stroke.named ?? stroke.lastNamed ?? 'solid' });
    } else {
      const dash: Member[] =
        stroke.dash.length > 0
          ? stroke.dash
          : [{ kind: 'scalar', fields: { kind: 'dimension', amount: '4', unit: 'px' } }];
      onchange({
        ...stroke,
        named: null,
        ...(stroke.named === null ? {} : { lastNamed: stroke.named }),
        dash,
      });
    }
  }
</script>

<div class="stroke" role="group" aria-label={subject}>
  <Select
    id={`${idBase}-form`}
    label={`${subject} form`}
    options={[
      { value: 'named', label: 'Named style' },
      { value: 'dashed', label: 'Dash array and line cap' },
    ]}
    value={structured ? 'dashed' : 'named'}
    {disabled}
    onchange={(event) => switchForm(event.currentTarget.value)}
  />

  {#if stroke.named !== null}
    <Select
      id={`${idBase}-named`}
      label={`${subject} style`}
      options={[
        ...((STROKE_KEYWORDS as readonly string[]).includes(stroke.named)
          ? []
          : [{ value: stroke.named, label: `${stroke.named} (not a stroke style)` }]),
        ...STROKE_KEYWORDS.map((keyword) => ({ value: keyword, label: keyword })),
      ]}
      value={stroke.named}
      {disabled}
      {...errors[at] === undefined ? {} : { error: errors[at] }}
      onchange={(event) => onchange({ ...stroke, named: event.currentTarget.value })}
    />
  {:else}
    <ol class="stroke__dashes">
      {#each stroke.dash as dash, index (index)}
        {@const name = `${subject} dash ${index + 1}`}
        <li class="stroke__dash">
          <ThemeCompositeMember
            spec={DASH_SPEC}
            member={dash}
            at={`${at}.dashArray.${index}`}
            {errors}
            idBase={`${idBase}-dash-${index}`}
            subject={name}
            {disabled}
            onchange={(next) =>
              setDash(stroke.dash.map((entry, at2) => (at2 === index ? next : entry)))}
            onreplace={() =>
              setDash(stroke.dash.map((entry, at2) => (at2 === index ? literalFor(entry) : entry)))}
            {announce}
            {onenter}
          />
          <ThemeReorderControls
            subject={name}
            {index}
            count={stroke.dash.length}
            idBase={`${idBase}-dash`}
            {disabled}
            canRemove={stroke.dash.length > 1}
            onmove={(delta) => setDash(moved(stroke.dash, index, delta))}
            onremove={() => setDash(stroke.dash.filter((_, at2) => at2 !== index))}
            {announce}
          />
        </li>
      {/each}
    </ol>
    {#if errors[at] !== undefined}
      <p class="stroke__error" role="alert">{errors[at]}</p>
    {/if}
    <Button
      id={`${idBase}-add-dash`}
      label="Add dash"
      aria-label={`Add a dash to ${subject}`}
      variant="secondary"
      size="sm"
      {disabled}
      onclick={() => {
        setDash([
          ...stroke.dash,
          { kind: 'scalar', fields: { kind: 'dimension', amount: '4', unit: 'px' } },
        ]);
        announce(`Added dash ${stroke.dash.length + 1} to ${subject}`);
      }}
    />
    <Select
      id={`${idBase}-cap`}
      label={`${subject} line cap`}
      options={[
        ...((LINE_CAPS as readonly string[]).includes(stroke.lineCap)
          ? []
          : [{ value: stroke.lineCap, label: `${stroke.lineCap} (not a line cap)` }]),
        ...LINE_CAPS.map((cap) => ({ value: cap, label: cap })),
      ]}
      value={stroke.lineCap}
      {disabled}
      {...errors[`${at}.lineCap`] === undefined ? {} : { error: errors[`${at}.lineCap`] }}
      onchange={(event) => onchange({ ...stroke, lineCap: event.currentTarget.value })}
    />
  {/if}
</div>

<style>
  .stroke,
  .stroke__dashes {
    display: grid;
    gap: 8px;
    min-width: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .stroke__dash {
    display: grid;
    gap: 8px;
    padding: 8px;
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-md);
  }
  .stroke__error {
    margin: 0;
    color: var(--cinder-status-danger-text, var(--cinder-text-default));
    font-size: var(--cinder-text-sm);
  }
</style>
