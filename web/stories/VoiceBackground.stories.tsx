import type { Meta, StoryObj } from '@storybook/react-vite';
import { VoiceBackgroundPrototype } from './prototypes/VoiceBackgroundPrototype';

const meta = {
  title: 'Prototypes/Voice Background',
  component: VoiceBackgroundPrototype,
  parameters: {
    layout: 'fullscreen',
    docs: { description: { component: 'Storybook-only shader experiment. Speech stirs irregular coloured currents through the existing 20px dot field. Distortion is strongest at the speaking orb’s edge, with a small outward push underneath the eddies. A short loudness history delays the response farther from the source, and distance weakens it. Compare silence, one voice, and overlapping speakers; strength controls displacement/brightness, spread controls the reach of the falloff. Pause speech holds the loudness and field, and Shader on compares with the original static dots. Uses simulated loudness only; reduced motion keeps the field still.' } },
  },
  args: { scenario: 'one-speaker', strength: 1.5, spread: 480, paused: false, enabled: true },
  argTypes: {
    scenario: { control: 'select', options: ['idle', 'one-speaker', 'overlapping'] },
    strength: { control: { type: 'range', min: 0, max: 3, step: .1 } },
    spread: { control: { type: 'range', min: 150, max: 1000, step: 25 } },
  },
} satisfies Meta<typeof VoiceBackgroundPrototype>;
export default meta;
type Story = StoryObj<typeof meta>;
export const OneSpeaker: Story = {};
export const Idle: Story = { args: { scenario: 'idle' } };
export const OverlappingSpeakers: Story = { args: { scenario: 'overlapping' } };
