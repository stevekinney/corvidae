/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: VideoPlayer } = await import('./video-player.svelte');

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, 'fullscreenEnabled');
  Reflect.deleteProperty(document, 'fullscreenElement');
  Reflect.deleteProperty(document, 'exitFullscreen');
});

const SOURCE = 'https://example.com/media/clip';
const LABEL = 'Sample clip';

function mediaElement(container: HTMLElement): HTMLMediaElement {
  return requiredInstance(container.querySelector('video'), HTMLMediaElement);
}

/** The play, pause, and replay button: the player also renders mute and full-screen toggles. */
function primaryButton(container: HTMLElement): HTMLButtonElement {
  return requiredInstance(
    container.querySelector('.cinder-media-controls__button'),
    HTMLButtonElement,
  );
}

async function loadDuration(media: HTMLMediaElement, duration: number, currentTime: number) {
  Object.defineProperty(media, 'duration', { configurable: true, value: duration });
  Object.defineProperty(media, 'currentTime', {
    configurable: true,
    writable: true,
    value: currentTime,
  });
  await fireEvent(media, new Event('loadedmetadata'));
}

describe('VideoPlayer', () => {
  test('renders a labelled group with the native element and controls', () => {
    const { container, getByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    expect(getByRole('group', { name: LABEL })).toBeTruthy();
    expect(mediaElement(container).getAttribute('src')).toBe(SOURCE);
    expect(mediaElement(container).hasAttribute('controls')).toBe(false);
    expect(primaryButton(container).getAttribute('data-cinder-state')).toBe('paused');
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
    const { container, queryByRole } = render(VideoPlayer, { src, label: LABEL });
    expect(mediaElement(container).hasAttribute('src')).toBe(false);
    const button = primaryButton(container);
    expect(button.getAttribute('data-cinder-state')).toBe('unavailable');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(queryByRole('button', { name: 'Mute' })).toBeNull();
  });

  test.each(['https://example.com/clip', 'http://example.com/clip', 'blob:https://example.com/id'])(
    'loads %s',
    (src) => {
      const { container } = render(VideoPlayer, { src, label: LABEL });
      expect(mediaElement(container).getAttribute('src')).toBe(src);
      expect(primaryButton(container).getAttribute('data-cinder-state')).toBe('paused');
    },
  );

  test('the play button calls play and the pause button calls pause', async () => {
    const { container } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    const media = mediaElement(container);
    const calls: string[] = [];
    media.play = () => {
      calls.push('play');
      return Promise.resolve();
    };
    media.pause = () => {
      calls.push('pause');
    };
    await fireEvent.click(primaryButton(container));
    await fireEvent(media, new Event('play'));
    expect(primaryButton(container).getAttribute('data-cinder-state')).toBe('playing');
    await fireEvent.click(primaryButton(container));
    expect(calls).toEqual(['play', 'pause']);
  });

  test('a rejected play call does not throw', async () => {
    const { container } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    mediaElement(container).play = () => Promise.reject(new Error('blocked'));
    await fireEvent.click(primaryButton(container));
    expect(primaryButton(container).getAttribute('data-cinder-state')).toBe('paused');
  });

  test('exposes a seek slider once the duration is known and seeks the element', async () => {
    const { container, getByRole, queryByRole } = render(VideoPlayer, {
      src: SOURCE,
      label: LABEL,
    });
    expect(queryByRole('slider')).toBeNull();
    const media = mediaElement(container);
    await loadDuration(media, 200, 50);
    const slider = requiredInstance(
      getByRole('slider', { name: `${LABEL} position` }),
      HTMLInputElement,
    );
    expect(slider.valueAsNumber).toBeCloseTo(0.25);
    slider.value = '0.5';
    await fireEvent.input(slider);
    expect(media.currentTime).toBeCloseTo(100);
  });

  test('shows the elapsed and total time once the duration is known', async () => {
    const { container, getByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    expect(container.querySelector('.cinder-media-controls__time')).toBeNull();
    const media = mediaElement(container);
    await loadDuration(media, 3725, 65);
    expect(container.querySelector('.cinder-media-controls__time')?.textContent).toBe(
      '1:05 / 1:02:05',
    );
    expect(getByRole('slider').getAttribute('aria-valuetext')).toBe('1:05 of 1:02:05');
  });

  test('the arrow keys move the position five seconds', async () => {
    const { container, getByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    const media = mediaElement(container);
    await loadDuration(media, 200, 50);
    await fireEvent.keyDown(getByRole('slider'), { key: 'ArrowRight' });
    expect(media.currentTime).toBeCloseTo(55);
    await fireEvent.keyDown(getByRole('slider'), { key: 'ArrowLeft' });
    expect(media.currentTime).toBeCloseTo(50);
  });

  test('the mute toggle mutes the element and follows its volumechange event', async () => {
    const { container, getByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    const media = mediaElement(container);
    const mute = getByRole('button', { name: 'Mute' });
    expect(mute.getAttribute('aria-pressed')).toBe('false');
    await fireEvent.click(mute);
    expect(media.muted).toBe(true);
    await fireEvent(media, new Event('volumechange'));
    expect(mute.getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(mute);
    expect(media.muted).toBe(false);
    await fireEvent(media, new Event('volumechange'));
    expect(mute.getAttribute('aria-pressed')).toBe('false');
  });

  test('hides the full-screen toggle where the document cannot go full screen', () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
    const { queryByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    expect(queryByRole('button', { name: 'Full screen' })).toBeNull();
  });

  test('the full-screen toggle takes the whole player full screen and back', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement,
    });
    const exits: string[] = [];
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: () => {
        exits.push('exit');
        return Promise.resolve();
      },
    });
    const { getByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    const group = getByRole('group', { name: LABEL });
    const requested: Element[] = [];
    group.requestFullscreen = () => {
      requested.push(group);
      return Promise.resolve();
    };
    const toggle = getByRole('button', { name: 'Full screen' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await fireEvent.click(toggle);
    expect(requested).toEqual([group]);
    fullscreenElement = group;
    await fireEvent(document, new Event('fullscreenchange'));
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(toggle);
    expect(exits).toEqual(['exit']);
    fullscreenElement = null;
    await fireEvent(document, new Event('fullscreenchange'));
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  test('replay restarts a finished track', async () => {
    const { container } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    const media = mediaElement(container);
    let plays = 0;
    media.play = () => {
      plays += 1;
      return Promise.resolve();
    };
    Object.defineProperty(media, 'currentTime', { configurable: true, writable: true, value: 9 });
    await fireEvent(media, new Event('ended'));
    const button = primaryButton(container);
    expect(button.getAttribute('data-cinder-state')).toBe('replay');
    await fireEvent.click(button);
    expect(media.currentTime).toBe(0);
    expect(plays).toBe(1);
  });

  test('shows loading while waiting and unavailable after a media error', async () => {
    const { container } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    const media = mediaElement(container);
    await fireEvent(media, new Event('waiting'));
    expect(primaryButton(container).getAttribute('data-cinder-state')).toBe('loading');
    await fireEvent(media, new Event('canplay'));
    expect(primaryButton(container).getAttribute('data-cinder-state')).toBe('paused');
    await fireEvent(media, new Event('error'));
    expect(primaryButton(container).getAttribute('data-cinder-state')).toBe('unavailable');
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
