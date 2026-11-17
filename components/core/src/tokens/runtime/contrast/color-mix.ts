import type { OklchColor } from './color-math.ts';

export function mixOklch(base: OklchColor, target: OklchColor, targetPercent: number): OklchColor {
  const weight = targetPercent / 100;
  const baseHue = base.c === 0 ? target.h : base.h;
  const targetHue = target.c === 0 ? base.h : target.h;
  let hueDelta = targetHue - baseHue;
  if (hueDelta > 180) hueDelta -= 360;
  if (hueDelta < -180) hueDelta += 360;
  return {
    l: base.l + (target.l - base.l) * weight,
    c: base.c + (target.c - base.c) * weight,
    h: baseHue + hueDelta * weight,
  };
}

/** `color-mix(in oklab, base, target <targetPercent>%)` for opaque colors, returned as OKLCH. */
export function mixOklab(base: OklchColor, target: OklchColor, targetPercent: number): OklchColor {
  const weight = targetPercent / 100;
  const toLab = ({ l, c, h }: OklchColor) => {
    const radians = (h * Math.PI) / 180;
    return { l, a: c * Math.cos(radians), b: c * Math.sin(radians) };
  };
  const from = toLab(base);
  const to = toLab(target);
  const a = from.a + (to.a - from.a) * weight;
  const b = from.b + (to.b - from.b) * weight;
  const c = Math.hypot(a, b);
  return {
    l: from.l + (to.l - from.l) * weight,
    c,
    h: c === 0 ? base.h : ((((Math.atan2(b, a) * 180) / Math.PI) % 360) + 360) % 360,
  };
}

/**
 * `status.*.subtle` / `status.*.muted`: the status tone mixed 36% toward a
 * neutral in OKLab (so the hue stays the tone's own instead of travelling
 * toward the neutral's), then capped at chroma 0.05.
 */
export function deriveStatusTier(base: OklchColor, target: OklchColor): OklchColor {
  const mixed = mixOklab(base, target, 36);
  return { ...mixed, c: Math.min(mixed.c, 0.05) };
}
