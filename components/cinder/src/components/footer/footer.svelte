<script lang="ts" module>
  export type { FooterGroup, FooterLink, FooterProps } from './footer.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';
  import type { FooterProps } from './footer.types.ts';

  let {
    brand,
    description,
    groups = [],
    legalLinks = [],
    copyright,
    label = 'Footer',
    class: className,
    ...rest
  }: FooterProps = $props();
</script>

<footer {...rest} class={classNames('cinder-footer', className)} aria-label={label}>
  <!--
    Every main-region prop is optional, so a footer carrying only `copyright` or
    `legalLinks` is valid. An unconditional wrapper would still be a grid item in that
    case, and the root's main-to-legal gap would open blank space above the legal row
    with no main region to separate it from. Render the wrapper only when it has content.
  -->
  {#if brand || description || groups.length > 0}
    <div class="cinder-footer__main">
      {#if brand || description}
        <section class="cinder-footer__brand">
          {#if brand}
            <h2 class="cinder-footer__brand-title">{brand}</h2>
          {/if}
          {#if description}
            <p class="cinder-footer__brand-description cinder-_value-text">{description}</p>
          {/if}
        </section>
      {/if}

      {#if groups.length > 0}
        <div class="cinder-footer__groups">
          {#each groups as group (group.id)}
            <nav aria-label={group.title}>
              <h3 class="cinder-footer__group-title cinder-_label-text">{group.title}</h3>
              <ul class="cinder-footer__list">
                {#each group.links as link (link.id)}
                  <li>
                    <a class="cinder-footer__link cinder-_value-text" href={link.href}
                      >{link.label}</a
                    >
                  </li>
                {/each}
              </ul>
            </nav>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if copyright || legalLinks.length > 0}
    <div class="cinder-footer__legal">
      {#if copyright}
        <span>{copyright}</span>
      {/if}

      {#if legalLinks.length > 0}
        <ul class="cinder-footer__legal-links">
          {#each legalLinks as link (link.id)}
            <li>
              <a class="cinder-footer__link cinder-_value-text" href={link.href}>{link.label}</a>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</footer>
