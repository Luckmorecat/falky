import type { Meta, StoryObj } from '@storybook/react-vite';
import { Message } from '../src/ui/Message';
import { t } from '../src/strings';

const meta = {
  title: 'Components/Message', component: Message, tags: ['autodocs'], parameters: { layout: 'fullscreen' },
  render: (args) => <Message title={args.title ?? t.noAccessTitle} body={args.body ?? t.noAccessBody} />,
} satisfies Meta<typeof Message>;
export default meta;
type Story = StoryObj<typeof Message>;
export const LinkRequired: Story = { render: () => <Message title={t.noAccessTitle} body={t.noAccessBody} /> };
export const LinkReplaced: Story = { render: () => <Message title={t.revokedTitle} body={t.revokedBody} /> };
export const NoRooms: Story = { render: () => <Message title={t.noRoomsTitle} body={t.noRoomsBody} /> };
export const LongText: Story = { render: () => <Message title={t.noAccessTitle} body={Array(8).fill(t.noAccessBody).join(' ')} /> };
export const CustomText: Story = { args: { title: 'Falky', body: 'Edit this message using Controls.' } };
