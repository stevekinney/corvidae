<script lang="ts">
  import { Checkbox, RadioGroup } from '@lostgradient/cinder';
  import { MarkdownEditor, type EditorMode, type MarkdownEditorProps } from '@lostgradient/editor';

  type Values = NonNullable<MarkdownEditorProps['placeholderValues']>;

  // Synthetic, non-sensitive schema covering every JSON kind, a nested
  // object, a nullable union, a whole array and a field with no sample value.
  const definitions = {
    schema: {
      type: 'object',
      properties: {
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
      },
    },
  } as const;

  const fillerLines = Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join('\n');
  let value = $state(
    `# Welcome\n\nHello {{name}}, this opening sentence is deliberately long so that it wraps several times inside the narrow editor frame.\n\n${fillerLines}\n`,
  );
  // Sample values for preview (COR-525). `rich` carries Markdown so the value
  // mode is visible: literal by default, strong text only with Markdown.
  const sampleValues: Values = {
    name: 'Ada',
    count: 3,
    enabled: true,
    nothing: null,
    items: [1, 'two'],
    settings: { b: 2, a: 1 },
    nullable: null,
    rich: '**bold**',
    user: { name: 'Grace' },
  };
  const valueSources: Record<string, Values | undefined> = {
    sample: sampleValues,
    empty: {},
    none: undefined,
  };

  let mode = $state<EditorMode>('source');
  let readonly = $state(false);
  let valueChangeCount = $state(0);
  let valueMode = $state<'text' | 'markdown'>('text');
  let valuesChoice = $state('sample');
  const placeholderValues = $derived(valueSources[valuesChoice]);
</script>

<div class="template-placeholders-fixture">
  <div class="controls">
    <Checkbox id="template-editor-readonly" label="Readonly" bind:checked={readonly} />
    <RadioGroup name="template-value-mode" label="Value mode" bind:value={valueMode}>
      <RadioGroup.Option id="template-value-mode-text" value="text" label="Literal" />
      <RadioGroup.Option id="template-value-mode-markdown" value="markdown" label="Markdown" />
    </RadioGroup>
    <RadioGroup name="template-values" label="Values" bind:value={valuesChoice}>
      <RadioGroup.Option id="template-values-sample" value="sample" label="Sample" />
      <RadioGroup.Option id="template-values-empty" value="empty" label="Empty object" />
      <RadioGroup.Option id="template-values-none" value="none" label="None" />
    </RadioGroup>
    <p>Value changes: <output data-testid="value-change-count">{valueChangeCount}</output></p>
    <p>Mode: <output data-testid="editor-mode">{mode}</output></p>
  </div>
  <pre data-testid="bound-value">{value}</pre>
  <div id="template-editor-mount">
    <MarkdownEditor
      id="template-editor"
      class="template-editor-frame"
      label="Template"
      bind:value
      bind:mode
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
</div>

<style>
  .template-placeholders-fixture {
    display: grid;
    gap: 1rem;
    max-inline-size: 60rem;
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: center;
  }

  #template-editor-mount {
    inline-size: 24rem;
  }

  #template-editor-mount :global(.template-editor-frame) {
    block-size: 22rem;
  }
</style>
