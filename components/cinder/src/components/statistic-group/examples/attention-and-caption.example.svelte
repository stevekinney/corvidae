<script lang="ts" module>
  export const title = 'Attention dot and caption';
  export const description =
    'An amber attention dot marks a non-zero bad count, and a caption under the value says what the number means in words. A zero count shows neither the dot nor a worry.';
</script>

<script lang="ts">
  import { StatisticGroup } from '@lostgradient/cinder';
</script>

<StatisticGroup label="Health" columns={4}>
  <StatisticGroup.Statistic label="Running now" value={0} caption="Nothing is running" />
  <StatisticGroup.Statistic
    label="Needs you"
    value={2}
    attention
    caption="An approval and a question"
  />
  <StatisticGroup.Statistic label="Failed in 24 hours" value={0} caption="No failed runs" />
  <StatisticGroup.Statistic
    label="Missed schedule runs (7 days)"
    value={4}
    attention
    caption="Daily summary"
  />
</StatisticGroup>
