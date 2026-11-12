/**
 * Controls smaller than 44px reach a coarse pointer through a pseudo-element hit area that takes
 * no layout space, as the Button does (`button-hit-area.test.ts`), never by sizing the control
 * itself to 44px. The coarse media query cannot be evaluated here, so these pin the CSS shapes.
 */
import { describe, expect, test } from 'bun:test';

const read = (path: string): Promise<string> =>
  Bun.file(new URL(`../components/${path}`, import.meta.url)).text();

const HIT_AREA_INSETS =
  /inset-block:\s*min\(0px, calc\(\(100% - var\(--cinder-touch-target-min\)\) \/ 2\)\);\s*inset-inline:\s*min\(0px, calc\(\(100% - var\(--cinder-touch-target-min\)\) \/ 2\)\);/;

/** The rule body of the first block whose selector list ends with `selector`, or ''. */
const ruleBody = (css: string, selector: string): string => {
  const index = css.indexOf(`${selector} {`);
  if (index === -1) return '';
  return css.slice(index, css.indexOf('}', index));
};

const SIZES_THE_LAYOUT =
  /min-(?:block|inline)-size:\s*(?:var\(--cinder-touch-target-min\)|2\.75rem)/;

describe('hit areas that take no layout space', () => {
  test('the number-input stepper is a positioned control with a pseudo-element hit area', async () => {
    const css = await read('number-input/number-input.css');
    const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));
    expect(coarse).not.toMatch(SIZES_THE_LAYOUT);
    expect(coarse).toContain('.cinder-number-input__stepper {\n      position: relative;');
    const rule = ruleBody(coarse, '.cinder-number-input__stepper::after');
    expect(rule).toContain('position: absolute;');
    expect(rule).toMatch(HIT_AREA_INSETS);
  });

  test('the carousel dot is its painted size, with the hit area a pseudo-element', async () => {
    const css = await read('carousel/carousel.css');
    expect(css).toContain('width: var(--cinder-carousel-dot-size, 1.5rem);');
    const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));
    const rule = ruleBody(coarse, '.cinder-carousel__dot::after');
    expect(rule).toContain('position: absolute;');
    expect(rule).toMatch(HIT_AREA_INSETS);
    expect(css).not.toContain('2.75rem');
  });

  test('the restart-state summary keeps its box, and its action is the Button with its own hit area', async () => {
    const css = await read('restart-state/restart-state.css');
    const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));
    expect(coarse).not.toMatch(SIZES_THE_LAYOUT);
    expect(css).not.toContain('.cinder-restart-state__actions .cinder-button');
    const rule = ruleBody(coarse, '.cinder-restart-state__details-summary::after');
    expect(rule).toContain('position: absolute;');
    expect(rule).toMatch(HIT_AREA_INSETS);
  });

  test('the banner sizes neither its actions nor the Button heights to 44px', async () => {
    const css = await read('banner/banner.css');
    expect(css).not.toMatch(SIZES_THE_LAYOUT);
    expect(css).not.toMatch(/--cinder-button-height-(?:xs|sm|md):/);
  });
});
