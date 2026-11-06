import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Toggle } from '../src/ui/Toggle';
import { t } from '../src/strings';

const meta = {
  title: 'Components/Toggle', component: Toggle, tags: ['autodocs'],
  args: { checked: false, disabled: false, onChange: () => {} },
  argTypes: { label: { control: 'text' } },
  decorators: [(Story) => <div className="sb-stack"><Story /></div>],
  render: (args) => <Toggle {...args} label={args.label ?? t.noiseSuppression} />,
} satisfies Meta<typeof Toggle>;
export default meta;
type Story = StoryObj<typeof Toggle>;
export const Off: Story = { render: meta.render, args: meta.args };
export const On: Story = { render: meta.render, args: { ...meta.args, checked: true } };
export const Disabled: Story = { render: meta.render, args: { ...meta.args, checked: true, disabled: true } };
export const Interactive: Story = {
  render: function Interactive() {
    const [checked, setChecked] = useState(false);
    return <><Toggle label={t.noiseSuppression} checked={checked} onChange={setChecked} /><output aria-live="polite">{t.noiseSuppression}: {String(checked)}</output></>;
  },
};
