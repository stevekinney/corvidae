import { describe, expect, test } from 'bun:test';
import { findEmptyStates } from './check-empty-state-layout';

describe('empty state layout', () => {
  test.each([
    ['a layout prop', '<EmptyState title="x" layout="row" />'],
    ['a size prop', '<EmptyState\n  size="compact"\n  title="x"\n/>'],
    ['an align prop', '<EmptyState title="x" align="start" />'],
    ['a hand-rolled class', '<p class="ib-workflows__empty">Nothing</p>'],
    ['a hand-rolled class beside others', '<div class="card weft-x-empty">Nothing</div>'],
    ['an empty-prefixed class', '<div class="empty-actions"></div>'],
    ['a bare empty line', '<p class="muted">{copy.empty}</p>'],
    ['a list item', '<li class="weft-events-tab__empty"><span>None</span></li>'],
  ])('reports %s', (_name, source) => {
    expect(findEmptyStates(`first line\n${source}`)).toHaveLength(1);
  });

  test('accepts the component with its defaults, kind and a class, and unrelated words', () => {
    expect(
      findEmptyStates(
        [
          '<EmptyState kind="filtered" title="x" class="weft-view__empty" onclick={() => { size = 1; }} />',
          '<EmptyState title="x"> {#snippet icon()}<Bot size={28} />{/snippet} </EmptyState>',
          '<p class="ib-empathy">x</p>',
          '<p>{emptyAction.label}</p>',
          '{#if !isEmpty}<p>{value}</p>{/if}',
          '<Button size="sm">Go</Button>',
          '<!-- <EmptyState layout="row" /> -->',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  test('reports the line of each site', () => {
    const source = '<EmptyState size="compact" title="a" />\nclean\n<p class="x__empty">b</p>';
    expect(findEmptyStates(source).map((site) => Number.parseInt(site))).toEqual([1, 3]);
  });
});
