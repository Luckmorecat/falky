import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../src/ui/Button';
import { Icon } from '../src/ui/Icon';
import { t } from '../src/strings';

const meta = { title: 'Components/Button', component: Button, tags: ['autodocs'], args: { variant: 'secondary', disabled: false }, argTypes: { children: { control: 'text' }, variant: { control: 'select', options: ['primary', 'secondary', 'join'] } }, render: (args) => <Button {...args}>{args.children ?? t.save}</Button> } satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Playground: Story = {};
export const Appearances: Story = {
  render: () => <div className="sb-stack"><Button variant="primary">{t.enter}</Button><div><Button>{t.save}</Button></div><div><Button variant="join"><Icon name="mic" />{t.join}</Button></div></div>,
};
export const Disabled: Story = {
  render: () => <div className="sb-stack"><Button variant="primary" disabled>{t.enter}</Button><div><Button disabled>{t.save}</Button></div><div><Button variant="join" disabled><Icon name="mic" />{t.joining}</Button></div></div>,
};
export const Interactive: Story = {
  render: function Interactive(args) {
    const [count, setCount] = useState(0);
    return <div className="sb-stack"><Button {...args} onClick={() => setCount(count + 1)}>{t.save}</Button><output aria-live="polite">{t.save}: {count}</output></div>;
  },
};
