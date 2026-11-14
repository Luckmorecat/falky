import type { Meta, StoryObj } from '@storybook/react-vite';
import { LiveBackgroundPreview } from './live-background/LiveBackgroundPreview';

const meta = {
  title: 'Features/Live Background',
  component: LiveBackgroundPreview,
  parameters: {
    layout: 'fullscreen',
    docs: { description: { component: 'The production live background, with simulated speech and theme controls in one scene. Voices stir coloured currents outward from their orbs. Changing theme sends two water-like fronts from opposite corners; dots surge, curl together in the centre, and settle into the new theme. Toggle or replay a transition during speech, silence the voices to compare, or switch to the original static dots. Strength and spread control voice reactions. Speed slows only the theme transition; speech keeps its normal tempo. Pause holds the field, and reduced motion makes the background still. No microphone or backend is needed.' } },
  },
  args: { speed: 1, reducedMotion: false, speakers: 'none', strength: 1.5, spread: 480, enabled: true, unread: false },
  argTypes: {
    speed: { control: 'select', options: [.25, .5, 1] },
    speakers: { control: 'select', options: ['none', 'one', 'two'] },
    strength: { control: { type: 'range', min: 0, max: 3, step: .1 } },
    spread: { control: { type: 'range', min: 150, max: 1000, step: 25 } },
  },
} satisfies Meta<typeof LiveBackgroundPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ThemeTransition: Story = {};
export const OneSpeaker: Story = { args: { speakers: 'one' } };
export const OverlappingSpeakers: Story = { args: { speakers: 'two' } };
export const SlowMotion: Story = { args: { speed: .25, speakers: 'two' } };
export const ReducedMotion: Story = { args: { reducedMotion: true, speakers: 'one' } };
export const StaticBackground: Story = { args: { enabled: false, speakers: 'two' } };

export const UnreadBeacon: Story = { args: { unread: true } };
export const UnreadBeaconWithSpeech: Story = { args: { unread: true, speakers: 'two' } };
export const UnreadBeaconReducedMotion: Story = { args: { unread: true, reducedMotion: true } };
