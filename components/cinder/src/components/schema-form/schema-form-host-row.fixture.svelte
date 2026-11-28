<script lang="ts">
  /**
   * A settings list in which the rows are a host's own, as Interborough's Advanced list is: each
   * row is a `SettingRow` the host draws, and a `SchemaForm` with `rootRowHosted` hands the row
   * its one control (a lone number, a lone choice) for the control column, and draws what is
   * left under the row. The reference rows are plain scalar rows of the same list. The geometry
   * tests measure that the hosted rows are the height, width and spacing of the reference ones.
   *
   * A reference control is in a plain `div`, as Interborough's `SettingField` draws every scalar
   * (a `div` that listens for focus leaving): that `div` is the row's column child, so a number
   * keeps its ten-character cap, at the column's end on a wide row and at the leading edge on a
   * narrow one.
   */
  import type { Snippet } from 'svelte';

  import DurationField from '../duration-field/duration-field.svelte';
  import FormSection from '../form-section/form-section.svelte';
  import NumberInput from '../number-input/number-input.svelte';
  import Segment from '../segment/segment.svelte';
  import SegmentedControl from '../segmented-control/segmented-control.svelte';
  import SettingRow from '../setting-row/setting-row.svelte';
  import SchemaForm from './schema-form.svelte';

  const DESCRIPTION = 'One line of words.';

  const limit = {
    type: 'object',
    title: 'Payload size',
    properties: {
      maxBytes: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }], title: 'Max bytes' },
    },
  };

  const options = {
    title: 'Options',
    anyOf: [
      { type: 'boolean', const: false },
      {
        type: 'object',
        title: 'Custom setup',
        properties: { count: { type: 'integer', title: 'Count' } },
      },
    ],
  };

  // A word or an object, as Interborough's checkpoints are: the row draws the choice in its control
  // column, and the form draws the object's fields under the row with no choice of its own.
  const wordOrObject = {
    anyOf: [
      { type: 'string', const: 'keep-all' },
      {
        type: 'object',
        properties: {
          keepLast: { type: 'integer', title: 'Keep last' },
          timeoutMilliseconds: { type: 'integer' },
        },
      },
    ],
  };

  let limitControl = $state<Snippet | undefined>(undefined);
  let offControl = $state<Snippet | undefined>(undefined);
  let customControl = $state<Snippet | undefined>(undefined);
</script>

<div class="schema-form-host-row">
  <FormSection columns={1}>
    <div data-testid="scalar">
      <SettingRow id="scalar" label="Scalar" description={DESCRIPTION}>
        {#snippet control()}
          <div><NumberInput id="scalar" label="Scalar" value={5} /></div>
        {/snippet}
      </SettingRow>
    </div>

    <div data-testid="lone-number">
      <SettingRow id="lone-number" label="Payload size" description={DESCRIPTION}>
        {#snippet control()}
          {#if limitControl}{@render limitControl()}{/if}
        {/snippet}
        {#snippet disclosure()}
          <fieldset class="schema-form-host-row__form">
            <SchemaForm
              schema={limit}
              value={{ maxBytes: null }}
              variant="setting-rows"
              rootRowHosted
              jsonEditable={false}
              onRootControl={(next) => (limitControl = next)}
            />
          </fieldset>
        {/snippet}
      </SettingRow>
    </div>

    <div data-testid="choice-off">
      <SettingRow id="choice-off" label="Options (off)" description={DESCRIPTION}>
        {#snippet control()}
          {#if offControl}{@render offControl()}{/if}
        {/snippet}
        {#snippet disclosure()}
          <fieldset class="schema-form-host-row__form">
            <SchemaForm
              schema={options}
              value={false}
              variant="setting-rows"
              rootRowHosted
              jsonEditable={false}
              onRootControl={(next) => (offControl = next)}
            />
          </fieldset>
        {/snippet}
      </SettingRow>
    </div>

    <div data-testid="choice-custom">
      <SettingRow id="choice-custom" label="Options (custom)" description={DESCRIPTION}>
        {#snippet control()}
          {#if customControl}{@render customControl()}{/if}
        {/snippet}
        {#snippet disclosure()}
          <fieldset class="schema-form-host-row__form">
            <SchemaForm
              schema={options}
              value={{ count: 3 }}
              variant="setting-rows"
              rootRowHosted
              jsonEditable={false}
              onRootControl={(next) => (customControl = next)}
            />
          </fieldset>
        {/snippet}
      </SettingRow>
    </div>

    <div data-testid="scalar-after">
      <SettingRow id="scalar-after" label="Scalar after" description={DESCRIPTION}>
        {#snippet control()}
          <div><NumberInput id="scalar-after" label="Scalar after" value={7} /></div>
        {/snippet}
      </SettingRow>
    </div>

    <!-- A row whose control sits at the end (the default), with a duration in a wrapper, as a
         host draws one: the pair is never stretched, so its number keeps to the number's cap. It
         comes before the longer rows so a phone's first screen shows it stacked. -->
    <div data-testid="guard-duration">
      <SettingRow id="guard-duration" label="Guard" description={DESCRIPTION}>
        {#snippet control()}
          <div>
            <DurationField id="guard-duration" label="Guard" value={120_000} unit="min" />
          </div>
        {/snippet}
      </SettingRow>
    </div>

    <div data-testid="word-custom">
      <SettingRow id="word-custom" label="Word or object" description={DESCRIPTION}>
        {#snippet control()}
          <SegmentedControl
            id="word-custom-choice"
            label="Word or object"
            // hidden-label-allowed: the SettingRow beside the control draws its label and description
            labelVisible={false}
            value="object"
          >
            <Segment value="word">Keep all</Segment>
            <Segment value="object">Custom</Segment>
          </SegmentedControl>
        {/snippet}
        {#snippet disclosure()}
          <fieldset class="schema-form-host-row__form">
            <SchemaForm
              schema={wordOrObject}
              value={{ keepLast: 5, timeoutMilliseconds: 60_000 }}
              jsonEditable={false}
              rootChoiceVisible={false}
            />
          </fieldset>
        {/snippet}
      </SettingRow>
    </div>

    <div data-testid="scalar-end">
      <SettingRow id="scalar-end" label="Scalar end" description={DESCRIPTION}>
        {#snippet control()}
          <div><NumberInput id="scalar-end" label="Scalar end" value={9} /></div>
        {/snippet}
      </SettingRow>
    </div>
  </FormSection>
</div>

<style>
  .schema-form-host-row {
    inline-size: min(100%, var(--cinder-content-width-reading));
    padding: var(--cinder-space-4);
  }

  .schema-form-host-row__form {
    min-inline-size: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  /* The host saves as a row is left, as Interborough's settings do, so the form's own submit
     button is not drawn. */
  .schema-form-host-row__form :global(button[type='submit']) {
    display: none;
  }

  .schema-form-host-row__form:has(> :global(.cinder-schema-form[data-cinder-root-body='none'])) {
    display: none;
  }
</style>
