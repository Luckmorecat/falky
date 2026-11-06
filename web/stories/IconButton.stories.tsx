import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { IconButton } from '../src/ui/IconButton';
import { Icon } from '../src/ui/Icon';
import { t } from '../src/strings';

const meta = {
  title: 'Components/IconButton', component: IconButton, tags: ['autodocs'],
  args: { size: 'regular', disabled: false, 'aria-label': '' },
  argTypes: { size: { control: 'select', options: ['regular', 'small'] }, 'aria-pressed': { control: 'boolean' } },
  render: (args) => <IconButton {...args} aria-label={args['aria-label'] || t.settings}><Icon name="sliders" /></IconButton>,
} satisfies Meta<typeof IconButton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Playground: Story = {};
export const SizesAndStates: Story = {
  render: () => <div className="sb-row">
    <IconButton aria-label={t.settings} data-tip={t.settings}><Icon name="sliders" /></IconButton>
    <IconButton size="small" aria-label={t.close}><Icon name="x" /></IconButton>
    <IconButton className="off" aria-label={t.muteOff} aria-pressed><Icon name="micOff" /></IconButton>
    <IconButton className="sharing" aria-label={t.shareOff} aria-pressed><Icon name="screen" /></IconButton>
    <IconButton size="small" className="send" aria-label={t.send} disabled><Icon name="send" /></IconButton>
    <IconButton size="small" className="ghost" aria-label={t.fullscreen}><Icon name="expand" /></IconButton>
  </div>,
};
export const Interactive: Story = {
  render: function Interactive() {
    const [muted, setMuted] = useState(false);
    const label = muted ? t.muteOff : t.muteOn;
    return <div className="sb-stack"><IconButton className={muted ? 'off' : ''} aria-label={label} aria-pressed={muted} data-tip={label} onClick={() => setMuted(!muted)}><Icon name={muted ? 'micOff' : 'mic'} /></IconButton><output aria-live="polite">{label}</output></div>;
  },
};
