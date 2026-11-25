/// <reference lib="dom" />
/**
 * COR-2680: reads how loud a line of text is, for checking that a disabled row's reason never
 * reads louder than the name it explains. `toneOf` is self-contained so Playwright can serialize
 * it into the page: it returns the element's WCAG contrast ratio against the first opaque
 * background behind it, and its computed font size in pixels.
 */
export type Tone = { contrast: number; fontSize: number };

export function toneOf(element: Element): Tone {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const rgba = (color: string): [number, number, number, number] => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = '#000';
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!, a! / 255];
  };
  const luminance = ([r, g, b]: [number, number, number, number]): number => {
    const channel = (value: number) => {
      const s = value / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  let background: [number, number, number, number] = [255, 255, 255, 1];
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const color = rgba(getComputedStyle(node).backgroundColor);
    if (color[3] >= 0.99) {
      background = color;
      break;
    }
  }
  const foreground = rgba(getComputedStyle(element).color);
  const alpha = foreground[3];
  const blended: [number, number, number, number] = [
    foreground[0] * alpha + background[0] * (1 - alpha),
    foreground[1] * alpha + background[1] * (1 - alpha),
    foreground[2] * alpha + background[2] * (1 - alpha),
    1,
  ];
  const [lighter, darker] = [luminance(blended), luminance(background)].sort((a, b) => b - a);
  return {
    contrast: (lighter! + 0.05) / (darker! + 0.05),
    fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
  };
}
