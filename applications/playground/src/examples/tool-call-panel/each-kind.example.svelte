<script lang="ts" module>
  export const title = 'The panel for each kind of call';
  export const description =
    'A done call shows its Input and its Result as fields with secondary "Copy input" and "Copy result". The waiting call carries a quiet "Add a note" at the start of its last row, which opens a "Note" field and moves focus into it, then a secondary Deny and the only primary, Approve, at the row\'s end. A running call shows its Input and a Result that reads "The result appears when the call finishes." The three panels are the same width.';
</script>

<script lang="ts">
  import { ToolCallPanel } from '@lostgradient/cinder';
</script>

<div style="display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-start;">
  <ToolCallPanel
    placement="docked"
    name="Lookup order"
    identifier="lookup-order"
    status="done"
    duration="0.2s"
    input={{ orderId: '4471' }}
    result={{ amount: '$42.00', delivered: 'Monday', flag: 'Damaged' }}
  />
  <ToolCallPanel
    placement="docked"
    name="Issue refund"
    identifier="issue-refund"
    status="waiting"
    input={{ orderId: '4480', amount: '$27.25', reason: 'Arrived damaged' }}
    onApprove={() => undefined}
    onDeny={() => undefined}
  />
  <ToolCallPanel
    placement="docked"
    name="Lookup order"
    identifier="lookup-order"
    status="running"
    duration="1.2s"
    input={{ orderId: '4492' }}
  />
</div>
