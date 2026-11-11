<script lang="ts" module>
  export const title = 'Editable and read-only rows';
  export const description =
    'Each editable row shows a trailing affordance and becomes a text, select, date or toggle editor when activated; the read-only row has none.';
</script>

<script lang="ts">
  import { Inspector, InspectorRow } from '@lostgradient/cinder';

  let title = $state('Spring menu launch');
  let status = $state('open');
  let due = $state('2026-11-30');
  let notify = $state(true);
</script>

<div style="max-inline-size: 22rem;">
  <Inspector header="Details">
    <InspectorRow
      label="Title"
      kind="text"
      current={title}
      onCommit={(next) => (title = String(next))}
    >
      {#snippet value()}{title}{/snippet}
    </InspectorRow>
    <InspectorRow
      label="Status"
      kind="select"
      current={status}
      options={[
        { value: 'open', label: 'Open' },
        { value: 'closed', label: 'Closed' },
      ]}
      onCommit={(next) => (status = String(next))}
    >
      {#snippet value()}{status === 'open' ? 'Open' : 'Closed'}{/snippet}
    </InspectorRow>
    <InspectorRow label="Due" kind="date" current={due} onCommit={(next) => (due = String(next))}>
      {#snippet value()}{due}{/snippet}
    </InspectorRow>
    <InspectorRow
      label="Notify"
      kind="toggle"
      current={notify}
      onCommit={(next) => (notify = next === true)}
    >
      {#snippet value()}{notify ? 'On' : 'Off'}{/snippet}
    </InspectorRow>
    <InspectorRow label="Created">
      {#snippet value()}Nov 10, 2026{/snippet}
    </InspectorRow>
  </Inspector>
</div>
