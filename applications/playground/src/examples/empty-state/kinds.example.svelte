<script lang="ts" module>
  export const title = 'Every kind';
  export const description =
    'Why a view is empty sets the disc: first use is accent with a primary button, filtered is neutral with a secondary Clear filters, done is green with a quiet link, blocked is amber, not-found is neutral and disabled is neutral with a plug, for content a setting you chose holds back.';
</script>

<script lang="ts">
  import { Button, EmptyState, Link } from '@lostgradient/cinder';

  let cleared = $state(0);
</script>

<div style="display: grid; gap: 1.5rem;">
  <EmptyState
    kind="first-use"
    title="No runs yet"
    description="Start a workflow to see its runs here."
  >
    {#snippet action()}
      <Button variant="primary" label="Start a run" />
    {/snippet}
  </EmptyState>
  <EmptyState
    kind="filtered"
    title="No runs match these filters"
    description="Model switcher has no runs. Try another agent."
    onClearFilters={() => (cleared += 1)}
  />
  <p>Filters cleared {cleared} times.</p>
  <EmptyState
    kind="done"
    title="All caught up"
    description="Nothing is waiting on you. When an agent asks for approval, it shows up here."
  >
    {#snippet action()}
      <Link href="#past-decisions">See past decisions</Link>
    {/snippet}
  </EmptyState>
  <EmptyState
    kind="blocked"
    title="Connect a model provider"
    description="Model agents can't answer until one is connected."
  />
  <EmptyState
    kind="disabled"
    title="2 agents are unavailable"
    description="Their plugin, Demo, is disabled. Enable it and restart to chat with them."
  />
  <EmptyState
    kind="not-found"
    title="This run doesn't exist"
    description="It may have been deleted. The address might also be mistyped."
  />
</div>
