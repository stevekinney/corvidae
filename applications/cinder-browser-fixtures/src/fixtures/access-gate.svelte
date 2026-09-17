<script lang="ts">
  import { AccessGate, Button } from '@repo/cinder';
  let granted = $state(false);
</script>

<main>
  <section id="example-mount-inline-denied">
    <AccessGate granted={false} reason="Requires scope: workflows:cancel">
      <Button label="Cancel workflow" variant="danger" />
    </AccessGate>
  </section>
  <section id="example-mount-section-denied">
    <AccessGate
      granted={false}
      variant="section"
      reason="Requires scope: storage:admin"
      requirement="storage:admin"
    />
  </section>
  <section id="example-mount-inline-toggle">
    <div data-access-gate-toggle-anchor>
      <AccessGate {granted} reason="Requires scope: workflows:cancel">
        <Button label="Cancel workflow" variant="danger" />
      </AccessGate>
    </div>
    <Button label="Toggle access" onclick={() => (granted = !granted)} />
  </section>
</main>
