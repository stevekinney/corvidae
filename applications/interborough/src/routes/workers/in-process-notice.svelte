<script lang="ts">
  /**
   * What the Workers page says when no worker is connected: this engine runs its work in-process,
   * so there is no fleet to show, and the tabs and their zeros stay out of the way. One sentence,
   * and under a disclosure the way to connect a worker, for the person who wants one. The page
   * keeps reading the fleet, so a worker that connects brings the full page back.
   */
  import { CodeBlock, Collapsible } from '@lostgradient/cinder';

  const serverUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/tasks/default/stream`;

  const snippet = `import { RemoteWorker } from '@lostgradient/weft';

const worker = new RemoteWorker({
  serverUrl: '${serverUrl}',
  workflows: {
    // Each workflow type this worker runs, with its activities.
  },
});

await worker.connect();`;

  const engineOption = "activityExecution: { mode: 'remote' }";
</script>

<section class="weft-workers-in-process" aria-label="Remote workers">
  <p class="weft-workers-in-process__sentence">
    This engine runs its work in-process. Remote workers are not configured.
  </p>
  <Collapsible trigger="Learn how to connect one" animated={false}>
    <div class="weft-workers-in-process__how">
      <p class="weft-workers-in-process__text">
        A remote worker takes the engine’s activities when the engine is created with
        <code class="ib-identifier">{engineOption}</code>, and it connects to this host like this.
        The guide is
        <code class="ib-identifier">packages/weft/documentation/guides/remote-workers.md</code>.
      </p>
      <CodeBlock code={snippet} language="ts" highlight={false} copyable />
    </div>
  </Collapsible>
</section>
