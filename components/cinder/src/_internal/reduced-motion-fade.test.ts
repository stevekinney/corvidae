/// <reference lib="dom" />
import { setupHappyDom } from '@lostgradient/testing';
import { afterEach, describe, expect, jest, test } from 'bun:test';

setupHappyDom();
const { REDUCED_MOTION_FADE_MILLISECONDS, playReducedMotionFade, reducedMotionFadeIn } =
  await import('./reduced-motion-fade.ts');

const originalAnimate = HTMLElement.prototype.animate;

afterEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: originalAnimate,
  });
});

function installAnimate(
  record: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => void,
): { finish: () => void; cancelled: () => boolean } {
  const listeners: Array<() => void> = [];
  let cancelled = false;
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    writable: true,
    value(_keyframes: Keyframe[], _options: KeyframeAnimationOptions) {
      record(_keyframes, _options);
      return {
        addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
        cancel: () => {
          cancelled = true;
        },
      };
    },
  });
  return {
    finish: () => listeners.forEach((listener) => listener()),
    cancelled: () => cancelled,
  };
}

describe('playReducedMotionFade', () => {
  test('fades in from transparent without filling', () => {
    let seen: [Keyframe[], KeyframeAnimationOptions] | undefined;
    installAnimate((keyframes, options) => (seen = [keyframes, options]));
    expect(playReducedMotionFade(document.createElement('div'), 'in')).not.toBeNull();
    expect(seen?.[0]).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(seen?.[1].duration).toBe(REDUCED_MOTION_FADE_MILLISECONDS);
    expect(seen?.[1].fill).toBe('none');
  });

  test('fades out to transparent and holds it', () => {
    let seen: [Keyframe[], KeyframeAnimationOptions] | undefined;
    installAnimate((keyframes, options) => (seen = [keyframes, options]));
    playReducedMotionFade(document.createElement('div'), 'out');
    expect(seen?.[0]).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(seen?.[1].fill).toBe('forwards');
  });

  test('settles `finished` when the animation finishes and stops it on cancel', async () => {
    const double = installAnimate(() => {});
    const fade = playReducedMotionFade(document.createElement('div'), 'out');
    let settled = false;
    void fade?.finished.then(() => {
      settled = true;
    });
    double.finish();
    await fade?.finished;
    expect(settled).toBe(true);
    fade?.cancel();
    expect(double.cancelled()).toBe(true);
  });

  test('settles on a timer when the finish event never comes, as in a page that is not rendering', async () => {
    jest.useFakeTimers();
    try {
      installAnimate(() => {});
      const fade = playReducedMotionFade(document.createElement('div'), 'out');
      let settled = false;
      void fade?.finished.then(() => {
        settled = true;
      });
      jest.advanceTimersByTime(REDUCED_MOTION_FADE_MILLISECONDS);
      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      expect(settled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('cancel clears the fallback timer so nothing is left pending', () => {
    jest.useFakeTimers();
    try {
      installAnimate(() => {});
      const fade = playReducedMotionFade(document.createElement('div'), 'in');
      expect(jest.getTimerCount()).toBe(1);
      fade?.cancel();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('returns null where Element.animate is missing', () => {
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    expect(playReducedMotionFade(document.createElement('div'), 'in')).toBeNull();
  });
});

describe('reducedMotionFadeIn', () => {
  test('fades in only when active at mount, and cancels on teardown', () => {
    let plays = 0;
    const double = installAnimate(() => {
      plays += 1;
    });
    const element = document.createElement('div');
    const inactive = reducedMotionFadeIn(() => false)(element);
    expect(plays).toBe(0);
    expect(inactive).toBeUndefined();
    const teardown = reducedMotionFadeIn(() => true)(element);
    expect(plays).toBe(1);
    (teardown as () => void)();
    expect(double.cancelled()).toBe(true);
  });
});
