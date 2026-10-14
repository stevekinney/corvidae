<script lang="ts">
  /*
   * A Cinder scale in order, drawn from the last-valid committed values (COR-489). Members keep
   * their Cinder names (`space.one`, `radius.medium`), not Tailwind's. Spacing draws a bar per
   * step; radius draws one rounded corner per step. Lengths are clamped so a very large value
   * (the full radius is 9999px) stays inside the pane.
   */
  import { catalogueRowByPath } from './theme-builder-catalogue.ts';
  import { cssLengthToPx, resolveCssValue } from './theme-foundation-values.ts';
  import { scaleMembers } from './theme-scale-presets.ts';

  type Props = { scale: string; values: ReadonlyMap<string, string>; current?: string };
  let { scale, values, current }: Props = $props();

  const MAX_BAR = 192;
  const MAX_CORNER = 24;

  const members = $derived(
    scaleMembers(scale)
      .map((path) => {
        const row = catalogueRowByPath(path);
        const css = row === undefined ? undefined : resolveCssValue(values, row.cssProperty);
        return { path, name: row?.name ?? path, css, px: cssLengthToPx(css) };
      })
      .toSorted((left, right) => (left.px ?? 0) - (right.px ?? 0)),
  );
  const clamp = (value: number | undefined, max: number) => Math.max(0, Math.min(value ?? 0, max));
</script>

<ol class="scale" data-testid="scale-preview" data-scale={scale} aria-label={`${scale} scale`}>
  {#each members as member (member.path)}
    <li
      class:current={member.path === current}
      aria-current={member.path === current ? 'true' : undefined}
      data-path={member.path}
    >
      <span class="scale__name">{member.name}</span>
      {#if scale === 'radius'}
        <span
          class="scale__corner"
          style={`border-top-left-radius: ${clamp(member.px, MAX_CORNER)}px;`}
          aria-hidden="true"
        ></span>
      {:else}
        <span
          class="scale__bar"
          style={`inline-size: ${clamp(member.px, MAX_BAR)}px;`}
          aria-hidden="true"
        ></span>
      {/if}
      <code>{member.css ?? 'n/a'}</code>
    </li>
  {/each}
</ol>

<style>
  .scale {
    display: grid;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--cinder-text-sm);
  }
  li {
    display: grid;
    grid-template-columns: minmax(5rem, 8rem) minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    padding: 2px 4px;
    border-radius: var(--cinder-radius-sm);
  }
  li.current {
    outline: 2px solid var(--cinder-accent-solid);
  }
  .scale__name {
    overflow-wrap: anywhere;
  }
  .scale__bar {
    display: block;
    block-size: 12px;
    background: var(--cinder-text-muted);
    border-radius: 2px;
  }
  .scale__corner {
    display: block;
    inline-size: 32px;
    block-size: 32px;
    border: 2px solid var(--cinder-text-muted);
    border-right: 0;
    border-bottom: 0;
  }
  code {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
  }
</style>
