<script lang="ts">
  import { TableOfContents } from '@lostgradient/cinder';
</script>

<div
  style="display: grid; grid-template-columns: 16rem 1fr; gap: var(--cinder-space-6); align-items: start;"
>
  <aside style="position: sticky; top: var(--cinder-space-4);">
    <TableOfContents target="#toc-example-article" />
  </aside>

  <article
    id="toc-example-article"
    style="display: flex; flex-direction: column; gap: var(--cinder-space-8);"
  >
    <section>
      <h2 id="overview">Overview</h2>
      <p style="margin: var(--cinder-space-2) 0 0;">A quick summary of what this page covers.</p>
    </section>
    <section>
      <h2 id="setup">Setup</h2>
      <p style="margin: var(--cinder-space-2) 0 0;">
        Install dependencies and configure your environment.
      </p>
      <h3 id="setup-install">Install packages</h3>
      <p style="margin: var(--cinder-space-2) 0 0;">
        Install the dependencies needed for your project.
      </p>
      <h3 id="setup-configure">Configure project</h3>
      <p style="margin: var(--cinder-space-2) 0 0;">Add and tune configuration values.</p>
    </section>
    <section>
      <h2 id="deployment">Deployment</h2>
      <p style="margin: var(--cinder-space-2) 0 0;">Push your build to production.</p>
    </section>
  </article>
</div>
