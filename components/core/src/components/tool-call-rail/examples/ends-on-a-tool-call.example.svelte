<script lang="ts" module>
  export const title = 'A turn that ends on a tool call';
  export const description =
    'A finished turn whose last step is a tool call closes the rail with the run\'s end state, "Run finished, no reply", on its own line with a check glyph, so the turn does not look hung. A call a person approved has a green dot ("Approved by you 10:33 AM, $18.50 refunded").';
</script>

<script lang="ts">
  import { ToolCallRail } from '@lostgradient/cinder';
</script>

<ToolCallRail
  calls={[
    {
      id: 'lookup',
      name: 'Lookup order',
      identifier: 'lookup-order',
      input: '4472',
      result: '$18.50, delivered Oct 29, flagged damaged',
      duration: '0.3s',
      status: 'done',
    },
    {
      id: 'refund',
      name: 'Issue refund',
      identifier: 'issue-refund',
      input: '4472',
      decision: 'Approved by you 10:33 AM, $18.50 refunded',
      duration: '0.6s',
      status: 'approved',
    },
  ]}
  endLabel="Run finished, no reply"
/>
