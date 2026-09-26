<script lang="ts">
  import { Checkbox } from '@lostgradient/cinder';
  import { MarkdownEditor, type EditorMode } from '@lostgradient/editor';

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
  let mode = $state<EditorMode>('source');
  let readonly = $state(false);
  let valueChangeCount = $state(0);
</script>

<div class="template-placeholders-fixture">
  <div class="controls">
    <Checkbox id="template-editor-readonly" label="Readonly" bind:checked={readonly} />
    <p>Value changes: <output data-testid="value-change-count">{valueChangeCount}</output></p>
  </div>
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
