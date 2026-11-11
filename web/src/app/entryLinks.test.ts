import { beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => { vi.resetModules(); history.replaceState(null, '', '/'); });
it('removes sensitive fragments while retaining exact decoded operator proof in memory until explicit exit', async () => {
  history.replaceState(null, '', '/?view=chat#recover=%20MiXeD%2BToken%20&account=%20ExactID%20&invite=Invitation&k=Guest&other=keep');
  const links = await import('./entryLinks');
  expect(links.captureEntryLinks()).toBe(true);
  expect(location.hash).toBe('#other=keep');
  expect(links.getEntryLinks()).toEqual({ guest: 'Guest', invitation: 'Invitation', recovery: { accountId: ' ExactID ', proof: ' MiXeD+Token ' } });
  expect(links.captureEntryLinks()).toBe(false);
  expect(links.getEntryLinks().invitation).toBe('Invitation');
  links.clearEntryLinks();
  expect(links.getEntryLinks()).toEqual({});
});


it('scrubs device fragments and preserves QR approval through ordinary account-flow clearing', async () => {
  const links = await import('./entryLinks');
  history.replaceState(null, '', '/#qr-signin=QR_Bearer&other=keep');
  expect(links.captureEntryLinks()).toBe(true);
  expect(location.hash).toBe('#other=keep');
  expect(links.getDeviceEntry()).toEqual({ type: 'qr', token: 'QR_Bearer' });
  links.clearEntryLinks();
  expect(links.getDeviceEntry()).toEqual({ type: 'qr', token: 'QR_Bearer' });
  links.clearDeviceEntry();
  expect(links.getDeviceEntry()).toBeNull();
});

it('accepts only unambiguous intended root URLs from this origin', async () => {
  const { parseDeviceSignInURL } = await import('./entryLinks');
  const root = location.origin;
  expect(parseDeviceSignInURL(`${root}/#signin=Exact_Bearer`)).toEqual({ type: 'link', token: 'Exact_Bearer' });
  for (const value of [
    `${root}/#signin=a&signin=b`, `${root}/#signin=a&qr-signin=b`,
    `${root}/#qr-signin=a&invite=x`, `${root}/#qr-signin=a&other=x`,
    `${root}/other#qr-signin=a`, `${root}/?token=a#qr-signin=b`,
    'https://foreign.example/#qr-signin=a', `${root.replace('://', '://user@')}/#qr-signin=a`,
    `${root}/#qr-signin=`, `${root}/#qr-signin=${'a'.repeat(257)}`,
    `${root}/#qr-signin=bad%20token`, `${root}/#qr-signin=%`,
  ]) expect(parseDeviceSignInURL(value)).toBeNull();
});

it('scrubs ambiguous device secrets without retaining either authority', async () => {
  const links = await import('./entryLinks');
  history.replaceState(null, '', '/#signin=one&qr-signin=two&other=keep');
  expect(links.captureEntryLinks()).toBe(true);
  expect(links.getDeviceEntry()).toBeNull();
  expect(location.hash).toBe('#other=keep');
});
