<script lang="ts">
  import { TableOfContents } from '@lostgradient/cinder';
</script>

<div class="example-grid gap-6">
  <aside class="aside">
    <TableOfContents target="#toc-example-article" />
  </aside>

  <article id="toc-example-article" class="toc-example-article-layout gap-8">
    <section>
      <h2 id="overview">Overview</h2>
      <p class="note">A quick summary of what this page covers.</p>
    </section>
    <section>
      <h2 id="setup">Setup</h2>
      <p class="note">Install dependencies and configure your environment.</p>
      <h3 id="setup-install">Install packages</h3>
      <p class="note">Install the dependencies needed for your project.</p>
      <h3 id="setup-configure">Configure project</h3>
      <p class="note">Add and tune configuration values.</p>
    </section>
    <section>
      <h2 id="deployment">Deployment</h2>
      <p class="note">Push your build to production.</p>
    </section>
  </article>
</div>

<style>
  .example-grid {
    display: grid;
    grid-template-columns: 16rem 1fr;
    align-items: start;
  }

  .aside {
    position: sticky;
    top: var(--cinder-space-4);
  }

  .toc-example-article-layout {
    display: flex;
    flex-direction: column;
  }

  .note {
    margin: var(--cinder-space-2) 0 0;
  }
</style>
