import { render } from '@testing-library/svelte';
import { expect, test } from 'bun:test';
import ReviewsNavigationFixture from './reviews-navigation.fixture.svelte';
import type { reviewsNavigation } from './reviews-navigation.ts';

test('navigation accepts only HTTP targets on the document origin', () => {
  const provided: ReturnType<typeof reviewsNavigation>[] = [];
  render(ReviewsNavigationFixture, { props: { receive: (value) => provided.push(value) } });
  const navigation = provided[0];
  if (!navigation) throw new Error('Navigation was not provided');
  for (const target of [
    'https://other.test/',
    '//other.test/',
    'javascript:alert(1)',
    'data:text/plain,x',
  ]) {
    expect(() => navigation.navigate(target)).toThrow();
  }
});
