import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { DeviceLinkFlow } from '../src/ui/DeviceLinkFlow';
import { Button } from '../src/ui/Button';
import { t } from '../src/strings';
import { createFixture, scenarios, type Scenario } from './device-link/fixture';
import './device-link/preview.css';

function Scene({ scenario, responseDelay }: { scenario: Scenario; responseDelay: number }) {
  const [fixture] = useState(() => createFixture(scenario, responseDelay));
  const [scanner, setScanner] = useState(false);
  return <div className="device-link-story">
    <aside className="device-link-story-controls" aria-label="Simulation controls">
      <p>Simulated flow · approval code: <strong>1234</strong>. Close the drawer to use these controls.</p>
      <div><Button onClick={fixture.receive}>Receive sign-in request</Button><Button onClick={fixture.expire}>Expire link</Button><Button onClick={fixture.finish}>Complete sign-in</Button></div>
    </aside>
    <main className="device-link-story-settings">
      <header><h2>{t.settings}</h2><span aria-hidden="true">×</span></header>
      <div className="device-link-story-tabs"><span>{t.sectionProfile}</span><strong>{t.account.account}</strong><span>{t.tabSystem}</span></div>
      <section className="device-link-story-stub" aria-label="Account layout placeholder"><span /><span /></section>
      <DeviceLinkFlow issuer={fixture.issuer} active disabled={false} defaultOpen={!['idle', 'revoked'].includes(scenario)} onScan={() => setScanner(true)} scanFocusRequested={false} onScanFocused={() => {}} />
      {scanner && <p className="sb-note" role="status">QR scanner placeholder. This story focuses on the sign-in link.</p>}
      <section className="device-link-story-stub" aria-label="Passkeys layout placeholder"><span /><span /><span /></section>
    </main>
  </div>;
}
function Preview({ scenario, responseDelay }: { scenario: Scenario; responseDelay: number }) { return <Scene key={`${scenario}-${responseDelay}`} scenario={scenario} responseDelay={responseDelay} />; }
const meta = {
  title: 'Flows/Create Sign-in Link',
  component: Preview,
  parameters: { layout: 'fullscreen', docs: { description: { component: 'Production link controls and drawer with a local simulated issuer. The surrounding Settings layout is stubbed. No backend, passkey, camera, or real sign-in link is used. Select a state in Controls, or start from Create and use the simulation controls. Enter 1234 to approve; another four-digit code demonstrates validation.' } } },
  args: { scenario: 'idle', responseDelay: 500 },
  argTypes: { scenario: { control: 'select', options: scenarios }, responseDelay: { name: 'Response delay (ms)', control: 'select', options: [0, 75, 150, 500, 2000] } },
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Create: Story = {};
export const FastResponse: Story = { args: { responseDelay: 75 } };
export const SlowResponse: Story = { args: { responseDelay: 2000 } };
export const Creating: Story = { args: { scenario: 'creating' } };
export const LinkReady: Story = { args: { scenario: 'ready' } };
export const EnterCode: Story = { args: { scenario: 'enter-code' } };
export const MultipleRequests: Story = { args: { scenario: 'multiple-requests' } };
export const WrongCode: Story = { args: { scenario: 'wrong-code' } };
export const Approved: Story = { args: { scenario: 'approved' } };
export const Complete: Story = { args: { scenario: 'complete' } };
export const Expired: Story = { args: { scenario: 'expired' } };
export const ExpiringSoon: Story = { args: { scenario: 'expiring-soon' } };
export const Revoked: Story = { args: { scenario: 'revoked' } };
export const LinkUnavailableAfterReload: Story = { args: { scenario: 'lost-link' } };
export const CreateError: Story = { args: { scenario: 'create-error' } };
export const RevokeError: Story = { args: { scenario: 'revoke-error' } };
export const RateLimited: Story = { args: { scenario: 'rate-limited' } };
