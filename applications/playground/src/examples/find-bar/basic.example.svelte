<script lang="ts" module>
  export const title = 'Basic find bar';
  export const description = 'A find-in-page control with match navigation.';
</script>

<script lang="ts">
  import { FindBar } from '@lostgradient/cinder';
</script>

<FindBar value="terminal" activeIndex={1} matchCount={4} />
