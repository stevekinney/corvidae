<script lang="ts">
  /**
   * The one quiet line that stands for a section with nothing in it, on Home and on Health
   * (`worth-showing.ts`, owner 2026-11-19): muted text in the body size, with no card, box, disc or
   * heading, so a page with nothing to report takes no room saying so. It is a `status` region, so
   * the words still reach a screen reader as the state of the page.
   */
  interface QuietLineProps {
    /** The words, one short sentence. */
    text: string;
    'data-testid'?: string;
  }

  let { text, 'data-testid': testId }: QuietLineProps = $props();
</script>

<p class="ib-quiet-line" role="status" data-quiet-line data-testid={testId}>{text}</p>

<style>
  .ib-quiet-line {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-base);
    line-height: var(--cinder-leading-normal);
  }
</style>
