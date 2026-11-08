import { type ComponentProps, type CSSProperties, useCallback, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Orb } from '../src/ui/Orb';
import { Tile } from '../src/ui/Tile';
import { Icon } from '../src/ui/Icon';
import { IconButton } from '../src/ui/IconButton';
import { PALETTE_NAMES } from '../src/fx/palette';
import { t } from '../src/strings';

// Synthetic loudness drives the production renderer without microphone access.
const speaking = () => 0.45 + Math.sin(performance.now() / 120) * 0.3;
type OrbStoryArgs = ComponentProps<typeof Orb> & { tileSize: number };
const meta = {
  title: 'Components/Orb', component: Orb, tags: ['autodocs'],
  args: { seed: 'workshop', palette: 'sky', still: false, tileSize: 460 },
  argTypes: {
    palette: { control: 'select', options: PALETTE_NAMES }, level: { control: false },
    tileSize: {
      name: 'Tile size (px)',
      description: 'The desktop app caps participant tiles at 460px. The orb fills 78% of the tile; the preview shrinks to fit its canvas.',
      control: { type: 'range', min: 80, max: 460, step: 10 },
    },
  },
  decorators: [(Story, context) => <div style={{
    width: context.name === 'Palettes' ? '100%' : context.args.tileSize,
    maxWidth: '100%', containerType: 'inline-size',
    '--sb-tile-size': `${context.args.tileSize}px`, '--t': 'min(var(--sb-tile-size), 100cqw)',
  } as CSSProperties}><Story /></div>],
  render: ({ tileSize: _, ...args }) => <div className="tile"><div className="t-orb"><Orb {...args} /></div></div>,
} satisfies Meta<OrbStoryArgs>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Idle: Story = {};
export const Speaking: Story = { args: { level: speaking } };
export const Still: Story = { args: { still: true } };
export const MuteToggle: Story = {
  args: { level: speaking },
  argTypes: { still: { control: false } },
  render: function MuteToggle(args) {
    const [muted, setMuted] = useState(false);
    const source = useRef({ muted, level: args.level });
    source.current = { muted, level: args.level };
    const level = useCallback(() => source.current.muted ? 0 : (source.current.level?.() ?? 0), []);
    const label = muted ? t.muteOff : t.muteOn;
    return <div className="sb-sample">
      <Tile id={args.seed} name="Alex" palette={args.palette} isSelf muted={muted} level={level} />
      <div className="sb-row">
        <IconButton className={muted ? 'off' : ''} aria-label={label} aria-pressed={muted} data-tip={label} onClick={() => setMuted((value) => !value)}>
          <Icon name={muted ? 'micOff' : 'mic'} />
        </IconButton>
        <output aria-live="polite">{label}</output>
      </div>
    </div>;
  },
};
export const SpeakerVolume: Story = {
  args: { seed: 'storybook-speaker-volume', level: speaking },
  argTypes: { still: { control: false } },
  render: (args) => <div className="sb-sample">
    <Tile id={args.seed} name="Sam" palette={args.palette} level={args.level} adjustable />
    <span className="sb-note">Hover or tap the orb to show volume. Scroll anywhere over the tile: up for louder, down for quieter. You can also drag the slider or use Tab and the arrow keys.</span>
  </div>,
};
export const Palettes: Story = {
  render: ({ tileSize: _, ...args }) => <div className="sb-gallery" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, var(--sb-tile-size)), 1fr))' }}>
    {PALETTE_NAMES.map((palette) => <div key={palette} className="tile">
      <div className="t-orb"><Orb {...args} seed="palette" palette={palette} /></div>
      <div className="t-label"><span className="t-name">{palette}</span></div>
    </div>)}
  </div>,
};
