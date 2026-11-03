<script lang="ts" module>
  export const title = 'Neutral banner';
  export const description =
    'The neutral variant for a page-wide note that is not a warning or a success: a stacked bold title over the sentence, with no status colour.';
</script>

<script lang="ts">
  import { Banner } from '@lostgradient/cinder';
</script>

<Banner variant="neutral" dismissible={false} title="This agent has no memory yet">
  Memory is written when the agent learns a fact about you. Nothing has been written.
</Banner>
