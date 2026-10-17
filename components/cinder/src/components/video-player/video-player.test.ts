/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: VideoPlayer } = await import('./video-player.svelte');

afterEach(() => {
  cleanup();
});

const SOURCE = 'https://example.com/media/clip';
const LABEL = 'Sample clip';

function mediaElement(container: HTMLElement): HTMLMediaElement {
  return requiredInstance(container.querySelector('video'), HTMLMediaElement);
}

describe('VideoPlayer', () => {
  test('renders a labelled group with the native element and controls', () => {
    const { container, getByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    expect(getByRole('group', { name: LABEL })).toBeTruthy();
    expect(mediaElement(container).getAttribute('src')).toBe(SOURCE);
    expect(mediaElement(container).hasAttribute('controls')).toBe(false);
    expect(getByRole('button').getAttribute('data-cinder-state')).toBe('paused');
  });

  test('passes the poster to the video element', () => {
    const { container } = render(VideoPlayer, {
      src: SOURCE,
      label: LABEL,
      poster: 'https://example.com/p.jpg',
    });
    expect(container.querySelector('video')?.getAttribute('poster')).toBe(
      'https://example.com/p.jpg',
    );
  });

  test.each([
    'javascript:alert(1)',
    'data:text/html,unsupported',
    'file:///etc/passwd',
    'ftp://example.com/clip',
    '',
  ])('renders the unavailable state and never loads %p', (src) => {
    const { container, getByRole } = render(VideoPlayer, { src, label: LABEL });
    expect(mediaElement(container).hasAttribute('src')).toBe(false);
    const button = getByRole('button', { hidden: true });
    expect(button.getAttribute('data-cinder-state')).toBe('unavailable');
    expect(button.getAttribute('aria-disabled')).toBe('true');
  });

  test.each(['https://example.com/clip', 'http://example.com/clip', 'blob:https://example.com/id'])(
    'loads %s',
    (src) => {
      const { container, getByRole } = render(VideoPlayer, { src, label: LABEL });
      expect(mediaElement(container).getAttribute('src')).toBe(src);
      expect(getByRole('button').getAttribute('data-cinder-state')).toBe('paused');
    },
  );

  test('the play button calls play and the pause button calls pause', async () => {
    const { container, getByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    const media = mediaElement(container);
    const calls: string[] = [];
    media.play = () => {
      calls.push('play');
      return Promise.resolve();
    };
    media.pause = () => {
      calls.push('pause');
    };
    await fireEvent.click(getByRole('button'));
    await fireEvent(media, new Event('play'));
    expect(getByRole('button').getAttribute('data-cinder-state')).toBe('playing');
    await fireEvent.click(getByRole('button'));
    expect(calls).toEqual(['play', 'pause']);
  });

  test('a rejected play call does not throw', async () => {
    const { container, getByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    mediaElement(container).play = () => Promise.reject(new Error('blocked'));
    await fireEvent.click(getByRole('button'));
    expect(getByRole('button').getAttribute('data-cinder-state')).toBe('paused');
  });

  test('exposes a seek slider once the duration is known and seeks the element', async () => {
    const { container, getByRole, queryByRole } = render(VideoPlayer, {
      src: SOURCE,
      label: LABEL,
    });
    expect(queryByRole('slider')).toBeNull();
    const media = mediaElement(container);
    Object.defineProperty(media, 'duration', { configurable: true, value: 200 });
    Object.defineProperty(media, 'currentTime', { configurable: true, writable: true, value: 50 });
    await fireEvent(media, new Event('loadedmetadata'));
    const slider = requiredInstance(
      getByRole('slider', { name: `${LABEL} position` }),
      HTMLInputElement,
    );
    expect(slider.valueAsNumber).toBeCloseTo(0.25);
    slider.value = '0.5';
    await fireEvent.input(slider);
    expect(media.currentTime).toBeCloseTo(100);
  });

  test('replay restarts a finished track', async () => {
    const { container, getByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    const media = mediaElement(container);
    let plays = 0;
    media.play = () => {
      plays += 1;
      return Promise.resolve();
    };
    Object.defineProperty(media, 'currentTime', { configurable: true, writable: true, value: 9 });
    await fireEvent(media, new Event('ended'));
    const button = getByRole('button');
    expect(button.getAttribute('data-cinder-state')).toBe('replay');
    await fireEvent.click(button);
    expect(media.currentTime).toBe(0);
    expect(plays).toBe(1);
  });

  test('shows loading while waiting and unavailable after a media error', async () => {
    const { container, getByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    const media = mediaElement(container);
    await fireEvent(media, new Event('waiting'));
    expect(getByRole('button', { hidden: true }).getAttribute('data-cinder-state')).toBe('loading');
    await fireEvent(media, new Event('canplay'));
    expect(getByRole('button').getAttribute('data-cinder-state')).toBe('paused');
    await fireEvent(media, new Event('error'));
    expect(getByRole('button', { hidden: true }).getAttribute('data-cinder-state')).toBe(
      'unavailable',
    );
  });

  test('merges the custom class and forwards rest attributes', () => {
    const { getByRole } = render(VideoPlayer, {
      src: SOURCE,
      label: LABEL,
      class: 'custom',
      'data-testid': 'player',
    });
    const group = getByRole('group');
    expect(group.classList.contains('cinder-video-player')).toBe(true);
    expect(group.classList.contains('custom')).toBe(true);
    expect(group.getAttribute('data-testid')).toBe('player');
  });
});
