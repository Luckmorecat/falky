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
