import { Button, Modal, type ButtonProps } from '@lostgradient/cinder';
import { describe, expect, it } from 'bun:test';

describe('@lostgradient/cinder root API', () => {
  it('exposes named component values and types from the single package entrypoint', () => {
    const props: Partial<ButtonProps> = { variant: 'primary' };
    expect(Button).toBeDefined();
    expect(Modal).toBeDefined();
    expect(props.variant).toBe('primary');
  });

  it('loads the root stylesheet side effect with the root API', async () => {
    const source = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(source).toContain("import './styles/index.css';");
  });
});
