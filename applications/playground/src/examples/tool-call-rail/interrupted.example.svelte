<script lang="ts" module>
  export const title = 'An interrupted call';
  export const description =
    'When the run ends while a call is under way, nobody knows how the call ended. The row shows a red circled cross and its result in red, with no arrow and never a green or neutral dot. The words follow the tool\'s risk: "Interrupted · didn\'t finish" for a tool that only reads, "Interrupted · may have run" for one that changes things. An interrupted call never folds away.';
</script>

<script lang="ts">
  import { ToolCallRail } from '@lostgradient/cinder';
</script>

<div style="display: grid; gap: 1.5rem;">
  <ToolCallRail
    calls={[
      {
        id: 'r1',
        name: 'Lookup order',
        identifier: 'lookup-order',
        input: '4471',
        result: "Interrupted · didn't finish",
        duration: '1.2s',
        status: 'interrupted',
      },
    ]}
  />
  <ToolCallRail
    calls={[
      {
        id: 'c1',
        name: 'Issue refund',
        identifier: 'issue-refund',
        input: '4471',
        result: 'Interrupted · may have run',
        duration: '1.2s',
        status: 'interrupted',
      },
    ]}
  />
</div>
