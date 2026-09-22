<script lang="ts">
  import { Card } from '@lostgradient/cinder';
  import { MarkdownEditor, type EditorMode } from '@lostgradient/editor';

  let basicValue = $state('# Release notes\n\nThis editor supports **rich markdown editing**.');
  let emptyValue = $state('');
  let prompt = $state(
    'You are a careful review agent.\n\n## Instructions\n\n- Read the patch before commenting.',
  );
  let mode = $state<EditorMode>('source');
</script>

<div class="markdown-fixture">
  <div id="example-mount-basic">
    <MarkdownEditor
      id="editor-basic"
      bind:value={basicValue}
      toolbarEnabled
      modeToggleVisible
      label="Markdown editor"
    />
  </div>
  <div id="example-mount-empty">
    <MarkdownEditor
      id="editor-empty"
      bind:value={emptyValue}
      toolbarEnabled={false}
      placeholder="Start writing your release notes…"
      label="Empty markdown editor"
    />
  </div>
  <div data-testid="markdown-editor-settings-card">
    <Card
      title="Agent prompt"
      description="The prompt is stored as Markdown and shown in a constrained settings column."
    >
      <MarkdownEditor
        id="agent-prompt"
        bind:value={prompt}
        bind:mode
        toolbarEnabled
        modeToggleVisible
        label="Agent prompt"
      />
    </Card>
  </div>
</div>

<style>
  .markdown-fixture {
    display: grid;
    gap: 1rem;
    max-inline-size: 60rem;
  }
  [data-testid='markdown-editor-settings-card'] {
    max-inline-size: 46rem;
    min-inline-size: 40rem;
    margin-inline: auto;
  }
</style>
