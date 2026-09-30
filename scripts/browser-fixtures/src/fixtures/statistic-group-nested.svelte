<script lang="ts">
  import { StatisticGroup } from '@lostgradient/cinder';

  const inner = ['wide', 'medium', 'narrow'];
</script>

<StatisticGroup id="statistic-group-outer" label="Overview" variant="default" columns={3}>
  {#each inner as name}
    <div class="statistic-group-nested-wrapper" id="statistic-group-wrapper-{name}">
      <StatisticGroup
        id="statistic-group-inner-{name}"
        label="Usage {name}"
        variant="default"
        columns={3}
      >
        <StatisticGroup.Statistic label="Projects" value={42} />
        <StatisticGroup.Statistic label="Members" value={18} />
        <StatisticGroup.Statistic label="Storage" value="64 GB" />
        <StatisticGroup.Statistic label="Builds" value={310} />
        <StatisticGroup.Statistic label="Deploys" value={97} />
        <StatisticGroup.Statistic label="Incidents" value={2} />
      </StatisticGroup>
    </div>
  {/each}
</StatisticGroup>

<style>
  .statistic-group-nested-wrapper {
    min-inline-size: 0;
    overflow-x: auto;
  }
</style>
