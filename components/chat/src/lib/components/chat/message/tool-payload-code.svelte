<script lang="ts" module>
  export type ToolPayloadCodeProps = {
    /** Structured payload text to render. */
    code: string;
    /** Whether the code block shows its `JSON` language label. Default `true`. */
    languageLabelVisible?: boolean;
    /** Additional CSS class. */
    class?: string;
  };
</script>

<script lang="ts">
  import { CodeBlock } from '@lostgradient/cinder';
  import { classNames } from '../../../utilities/class-names.ts';

  let { code, languageLabelVisible = true, class: className }: ToolPayloadCodeProps = $props();
</script>

<div class={classNames('tool-payload-code', className)}>
  <CodeBlock {code} language="json" {languageLabelVisible} scrollFadeVisible />
</div>

<style>
  .tool-payload-code {
    inline-size: 100%;
    min-inline-size: 0;
    max-inline-size: 100%;
  }

  .tool-payload-code :global(.cinder-code-block) {
    inline-size: 100%;
    border: 1px solid var(--cinder-border);
  }

  /* Cap tall payloads so a large arguments/result blob scrolls in place instead
   * of dominating the transcript. The viewport already owns overflow-x and is
   * focusable (tabindex=0), so adding a block-axis cap here keeps it keyboard-
   * scrollable on both axes without nesting scroll containers. Matches the
   * reasoning block's scroll region cap. */
  .tool-payload-code :global(.cinder-code-block__viewport) {
    max-block-size: 16rem;
    overflow-y: auto;
  }
</style>
