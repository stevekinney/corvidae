<script lang="ts" module>
  export const title = 'A denied call';
  export const description =
    'A call a person refused reads Denied, in neutral text with a prohibition glyph: it is not called Failed and carries no error block. The words are the caller\'s ("Denied by you 10:40 AM, nothing refunded"), and a denied call never folds away.';
</script>

<script lang="ts">
  import { ToolCallRail } from '@lostgradient/cinder';
</script>

<div style="display: grid; gap: 1.5rem;">
  <ToolCallRail
    calls={[
      {
        id: 'd1',
        name: 'Lookup order',
        identifier: 'lookup-order',
        input: '4471',
        result: '$42.00, delivered Mon',
        duration: '0.2s',
        status: 'done',
      },
      {
        id: 'd2',
        name: 'Issue refund',
        identifier: 'issue-refund',
        input: '4480, $27.25',
        result: 'Denied by you',
        duration: '0.1s',
        status: 'denied',
      },
    ]}
  />
  <ToolCallRail
    calls={[
      {
        id: 'e1',
        name: 'Lookup order',
        input: '4398',
        result: '$27.25, delivered Friday, flagged damaged',
        duration: '0.4s',
        status: 'done',
      },
      {
        id: 'e2',
        name: 'Issue refund',
        identifier: 'issue-refund',
        input: '4398',
        result: 'Denied by you 10:40 AM, nothing refunded',
        duration: '0.1s',
        status: 'denied',
      },
    ]}
    endLabel="Run finished, no reply"
  />
</div>
