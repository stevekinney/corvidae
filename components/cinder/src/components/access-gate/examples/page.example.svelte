<script lang="ts" module>
  export const title = 'Forbidden page';
  export const description =
    'The full-page layout for a page with nothing readable: what is blocked, the missing scope on its own line, and where to look.';
</script>

<script lang="ts">
  import { AccessGate, Button } from '@lostgradient/cinder';
</script>

<AccessGate
  granted={false}
  variant="section"
  layout="page"
  headingLevel={1}
  title="Your sign-in can’t open Hooks"
  reason="Settings › API reference › Your scopes shows what it can do."
  requirement="hooks:read"
>
  {#snippet actions()}
    <Button variant="secondary" label="See your scopes" />
    <Button variant="secondary" label="Back to Home" />
  {/snippet}
</AccessGate>
