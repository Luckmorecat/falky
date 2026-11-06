import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Segmented } from '../src/ui/Segmented';
import { t } from '../src/strings';

const meta = {
  title: 'Components/Segmented', component: Segmented, tags: ['autodocs'],
  decorators: [(Story) => <div className="sb-stack"><Story /></div>],
} satisfies Meta<typeof Segmented>;
export default meta;
type Story = StoryObj<typeof Segmented>;
export const Selected: Story = { render: () => <Segmented label={t.theme} value="dark" options={[["dark", t.themeDark], ["light", t.themeLight], ["system", t.themeSystem]]} onChange={() => {}} /> };
export const Disabled: Story = { render: () => <Segmented label={t.shareResolution} value="1080" options={[["720", '720p'], ["1080", '1080p'], ["1440", '1440p']]} onChange={() => {}} disabled /> };
export const Interactive: Story = {
  render: function Interactive() {
    const [value, setValue] = useState('motion');
    return <><Segmented label={t.shareFocus} value={value} options={[["motion", t.shareFocusMotion], ["detail", t.shareFocusDetail]]} onChange={setValue} /><output aria-live="polite">{t.shareFocus}: {value}</output></>;
  },
};
