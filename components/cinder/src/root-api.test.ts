import {
  ApprovalGroup,
  Button,
  DisclosureTrigger,
  Modal,
  type ApprovalGroupProps,
  type ButtonProps,
  type DisclosureTriggerProps,
} from '@lostgradient/cinder';
import { describe, expect, it } from 'bun:test';

describe('@lostgradient/cinder root API', () => {
  it('exposes named component values and types from the single package entrypoint', () => {
    const props: Partial<ButtonProps> = { variant: 'primary' };
    const approvalGroup: Partial<ApprovalGroupProps> = { label: 'Pending approvals' };
    const disclosure: Partial<DisclosureTriggerProps> = { controls: 'details' };
    expect(Button).toBeDefined();
    expect(Modal).toBeDefined();
    expect(ApprovalGroup).toBeDefined();
    expect(DisclosureTrigger).toBeDefined();
    expect(props.variant).toBe('primary');
    expect(approvalGroup.label).toBe('Pending approvals');
    expect(disclosure.controls).toBe('details');
  });

  it('loads the root stylesheet side effect with the root API', async () => {
    const source = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(source).toContain("import './styles/index.css';");
  });
});
