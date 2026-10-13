<script lang="ts">
  import { Checkbox, RadioGroup } from '@lostgradient/cinder';
  import { MarkdownEditor, type EditorMode, type MarkdownEditorProps } from '@lostgradient/editor';

  type Values = NonNullable<MarkdownEditorProps['placeholderValues']>;
  type Definitions = MarkdownEditorProps['placeholderDefinitions'];

  // The interactive example for Markdown template placeholders (COR-519).
  // Every value here is a fixed synthetic fixture; nothing comes from user
  // data. The schema covers every JSON kind, a nested object, a nullable
  // union, a whole array and a declared field with no sample value.
  const schemaProperties = {
    name: { type: 'string', description: 'Display name' },
    count: { type: 'integer' },
    enabled: { type: 'boolean' },
    nothing: { type: 'null' },
    items: { type: 'array', items: {} },
    settings: {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
    },
    nullable: { type: ['string', 'null'] },
    rich: { type: 'string' },
    user: { type: 'object', properties: { name: { type: 'string' } } },
    missing: { type: 'string', description: 'Declared without a sample value' },
  } as const;
  const schemaDefinitions: Definitions = {
    schema: { type: 'object', properties: schemaProperties },
  };
  // The same schema without the nested `user.name` property, so replacing the
  // catalog while the listbox is open visibly withdraws a path.
  const reducedSchemaDefinitions: Definitions = {
    schema: { type: 'object', properties: { ...schemaProperties, user: { type: 'object' } } },
  };
  // The explicit-candidate form of the same catalog.
  const candidateDefinitions: Definitions = {
    candidates: [
      { path: 'count', types: ['integer'] },
      { path: 'enabled', types: ['boolean'] },
      { path: 'items', types: ['array'] },
      { path: 'missing', types: ['string'], description: 'Declared without a sample value' },
      { path: 'name', types: ['string'], description: 'Display name' },
      { path: 'nothing', types: ['null'] },
      { path: 'nullable', types: ['string', 'null'] },
      { path: 'rich', types: ['string'] },
      { path: 'settings', types: ['object'] },
      { path: 'settings.a', types: ['integer'] },
      { path: 'settings.b', types: ['integer'] },
      { path: 'user', types: ['object'] },
      { path: 'user.name', types: ['string'] },
    ],
  };
  const definitionSources: Record<string, Definitions> = {
    schema: schemaDefinitions,
    reduced: reducedSchemaDefinitions,
    candidates: candidateDefinitions,
    empty: { candidates: [] },
    disabled: undefined,
  };

  const fillerLines = Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join('\n');
  let value = $state(
    `# Welcome\n\nHello {{name}}, this opening sentence is deliberately long so that it wraps several times inside the narrow editor frame.\n\n${fillerLines}\n`,
  );
  // The specification's synthetic preview values. `rich` carries Markdown so
  // the value interpretation is visible: literal by default, strong text only
  // with Markdown. `missing` is declared but deliberately has no value. The
  // specification gives no value for `user.name`; "Ada" is made up for this
  // fixture and differs from `name` so a nested fill is distinguishable.
  const sampleValues: Values = {
    name: 'Alice',
    count: 42,
    enabled: false,
    nothing: null,
    items: [1, 'x', null],
    settings: { b: 2, a: 1 },
    nullable: 'optional',
    rich: '**important**',
    user: { name: 'Ada' },
  };
  const valueSources: Record<string, Values | undefined> = {
    sample: sampleValues,
    empty: {},
    none: undefined,
  };

  // A second, independent editor with its own explicit candidates, to show
  // that listbox IDs, status regions and catalogs stay per instance.
  const secondDefinitions: Definitions = {
    candidates: [
      { path: 'name', types: ['string'] },
      { path: 'title', types: ['string'], description: 'Only in the second editor' },
    ],
  };
  let secondValue = $state('Second ');

  let mode = $state<EditorMode>('source');
  let readonly = $state(false);
  let valueChangeCount = $state(0);
  let valueMode = $state<'text' | 'markdown'>('text');
  let valuesChoice = $state('sample');
  let definitionsChoice = $state('schema');
  const definitions = $derived(definitionSources[definitionsChoice]);
  const placeholderValues = $derived(valueSources[valuesChoice]);

  // Publishes the template editor's ProseMirror selection as data attributes
  // on its mount so browser specs can wait for the editor to have read a
  // click. A `null` selection clears both values, which Svelte renders as
  // absent attributes: the same "unknown" state as before the first callback.
  let selectionFrom = $state<number | null>(null);
  let selectionTo = $state<number | null>(null);

  function publishSelection(selection: { from: number; to: number } | null): void {
    selectionFrom = selection?.from ?? null;
    selectionTo = selection?.to ?? null;
  }
</script>

<div class="template-placeholders-fixture">
  <div class="editors">
    <div
      id="template-editor-mount"
      data-selection-from={selectionFrom}
      data-selection-to={selectionTo}
    >
      <MarkdownEditor
        id="template-editor"
        class="template-editor-frame"
        label="Template"
        bind:value
        bind:mode
        onSelectionChange={publishSelection}
        {readonly}
        modeToggleVisible
        placeholderDefinitions={definitions}
        {placeholderValues}
        placeholderValueMode={valueMode}
        onValueChange={() => {
          valueChangeCount += 1;
        }}
      />
    </div>
    <div id="second-editor-mount">
      <MarkdownEditor
        id="second-editor"
        class="second-editor-frame"
        label="Second editor"
        bind:value={secondValue}
        mode="source"
        placeholderDefinitions={secondDefinitions}
      />
    </div>
  </div>
  <div class="fixture-panel">
    <div class="controls">
      <Checkbox id="template-editor-readonly" label="Readonly" bind:checked={readonly} />
      <RadioGroup name="template-definitions" label="Definitions" bind:value={definitionsChoice}>
        <RadioGroup.Option id="template-definitions-schema" value="schema" label="Schema" />
        <RadioGroup.Option
          id="template-definitions-reduced"
          value="reduced"
          label="Reduced schema"
        />
        <RadioGroup.Option
          id="template-definitions-candidates"
          value="candidates"
          label="Explicit candidates"
        />
        <RadioGroup.Option id="template-definitions-empty" value="empty" label="Empty" />
        <RadioGroup.Option id="template-definitions-disabled" value="disabled" label="Disabled" />
      </RadioGroup>
      <RadioGroup name="template-value-mode" label="Value interpretation" bind:value={valueMode}>
        <RadioGroup.Option id="template-value-mode-text" value="text" label="Literal text" />
        <RadioGroup.Option id="template-value-mode-markdown" value="markdown" label="Markdown" />
      </RadioGroup>
      <RadioGroup name="template-values" label="Preview data" bind:value={valuesChoice}>
        <RadioGroup.Option id="template-values-sample" value="sample" label="Sample" />
        <RadioGroup.Option id="template-values-empty" value="empty" label="Empty object" />
        <RadioGroup.Option id="template-values-none" value="none" label="Not supplied" />
      </RadioGroup>
      <p>Value changes: <output data-testid="value-change-count">{valueChangeCount}</output></p>
      <p>Mode: <output data-testid="editor-mode">{mode}</output></p>
    </div>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -- keyboard scrolling is intentional for overflow content. -->
    <pre data-testid="bound-value" role="region" aria-label="Bound value" tabindex="0">{value}</pre>
  </div>
</div>

<style>
  /*
   * The editor comes first, in DOM order and in the top-left cell, so the
   * number of controls beside it never moves it down the page: the popup
   * positioning specs rely on room below the caret. Narrow viewports stack
   * the columns.
   */
  .template-placeholders-fixture {
    display: grid;
    grid-template-columns: 24rem minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
    max-inline-size: 60rem;
  }

  @media (width < 48rem) {
    .template-placeholders-fixture {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .editors {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
  }

  .fixture-panel {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
  }

  .fixture-panel pre {
    overflow: auto;
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: center;
  }

  #template-editor-mount,
  #second-editor-mount {
    inline-size: min(24rem, 100%);
  }

  #template-editor-mount :global(.template-editor-frame) {
    block-size: 22rem;
  }

  #second-editor-mount :global(.second-editor-frame) {
    block-size: 8rem;
  }
</style>
