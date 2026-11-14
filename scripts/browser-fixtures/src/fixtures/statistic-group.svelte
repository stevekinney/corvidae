<script lang="ts">
  import { StatisticGroup } from '@lostgradient/cinder';
</script>

<StatisticGroup label="Workspace usage" columns="auto">
  <StatisticGroup.Statistic label="Projects" value={42} />
  <StatisticGroup.Statistic label="Members" value={18} />
  <StatisticGroup.Statistic label="Storage" value="64 GB" />
  <StatisticGroup.Statistic
    label="API calls"
    value={128400}
    valueFormatOptions={{ notation: 'compact' }}
  />
</StatisticGroup>

<!-- The plain variant (COR-2329): one stat in the page flow, with no frame. -->
<StatisticGroup label="Home counts" columns={1} variant="plain" data-testid="plain-group">
  <StatisticGroup.Statistic label="Failed in 24 hours" value={3} attention />
</StatisticGroup>

<!-- The same stat while it loads (COR-2329): the placeholder is one value line tall, so nothing
     under it moves when the number arrives. -->
<StatisticGroup label="Home counts" columns={1} variant="plain" data-testid="plain-group-loading">
  <StatisticGroup.Statistic label="Failed in 24 hours" value="" loading />
</StatisticGroup>
