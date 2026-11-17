<script lang="ts" module>
  export type { PreviewPanelProps, PreviewPanelStatus } from './preview-panel.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';
  import type { PreviewPanelProps } from './preview-panel.types.ts';

  let {
    title,
    status = 'idle',
    leading,
    actions,
    tabs,
    children,
    footer,
    class: customClassName,
    ...rest
  }: PreviewPanelProps = $props();

  const titleId = $props.id();
  const error = $derived(status === 'error');
</script>

<div
  {...rest}
  class={classNames('cinder-preview-panel', customClassName)}
  data-cinder-status={status}
  aria-labelledby={titleId}
  role={error ? 'alert' : undefined}
>
  <header class="cinder-preview-panel__header">
    {#if leading}
      <div class="cinder-preview-panel__leading">
        {@render leading()}
      </div>
    {/if}
    <h2 id={titleId} class="cinder-preview-panel__title">{title}</h2>
    <span class="cinder-preview-panel__status">{status}</span>
    {#if actions}
      <div class="cinder-preview-panel__actions">
        {@render actions()}
      </div>
    {/if}
  </header>

  {#if tabs}
    <div class="cinder-preview-panel__tabs">
      {@render tabs()}
    </div>
  {/if}

  <div class="cinder-preview-panel__body">
    {@render children()}
  </div>

  {#if footer}
    <footer class="cinder-preview-panel__footer">
      {@render footer()}
    </footer>
  {/if}
</div>
