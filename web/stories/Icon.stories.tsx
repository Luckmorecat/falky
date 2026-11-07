import type { Meta, StoryObj } from '@storybook/react-vite';
import { Icon, type IconName } from '../src/ui/Icon';

const names: IconName[] = ['mic', 'micOff', 'head', 'headOff', 'screen', 'sliders', 'x', 'chat', 'send', 'down', 'vol', 'chevron', 'expand', 'collapse'];
const meta = { title: 'Components/Icon', component: Icon, tags: ['autodocs'], args: { name: 'mic' }, argTypes: { name: { control: 'select', options: names } } } satisfies Meta<typeof Icon>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Playground: Story = {};
export const Gallery: Story = {
  render: () => <div className="sb-gallery">{names.map((name) => <div className="sb-sample" key={name}><Icon name={name} /><span className="sb-note">{name}</span></div>)}</div>,
};
