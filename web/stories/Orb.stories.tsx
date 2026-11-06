import type { Meta, StoryObj } from '@storybook/react-vite';
import { Orb } from '../src/ui/Orb';
import { PALETTE_NAMES } from '../src/fx/palette';

// Synthetic loudness drives the production renderer without microphone access.
const speaking = () => 0.45 + Math.sin(performance.now() / 120) * 0.3;
const meta = {
  title: 'Components/Orb', component: Orb, tags: ['autodocs'],
  args: { seed: 'workshop', palette: 'sky', still: false },
  argTypes: { palette: { control: 'select', options: PALETTE_NAMES }, level: { control: false } },
  decorators: [(Story, context) => <div style={{ width: context.name === 'Palettes' ? '100%' : 240, maxWidth: '100%' }}><Story /></div>],
} satisfies Meta<typeof Orb>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Idle: Story = {};
export const Speaking: Story = { args: { level: speaking } };
export const Still: Story = { args: { still: true } };
export const Palettes: Story = {
  render: () => <div className="sb-gallery">{PALETTE_NAMES.map((palette) => <div key={palette} className="sb-sample"><Orb seed="palette" palette={palette} /><span className="sb-note">{palette}</span></div>)}</div>,
};
