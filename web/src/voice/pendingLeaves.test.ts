import { afterEach, expect, it, vi } from 'vitest';
import { PendingLeaves } from './pendingLeaves';

const queues: PendingLeaves[] = [];
afterEach(() => { queues.forEach((queue) => queue.dispose()); queues.length = 0; localStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('persists exact Leave intent before HTTP, retains an ambiguous failure across reload, and clears only durable acknowledgement', async () => {
  let acknowledge = false;
  const requests: string[] = [];
  const persistedAtSend: boolean[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const { grantId } = JSON.parse(init.body as string);
    requests.push(grantId);
    persistedAtSend.push(Object.keys(localStorage).some((key) => key.endsWith(grantId)));
    return Response.json(acknowledge ? { revoked: true } : { code: 'visitor_required', message: 'Expired' }, { status: acknowledge ? 200 : 401 });
  }));
  const first = new PendingLeaves(() => {}); queues.push(first);
  await first.add('alex.old');
  expect(first.count).toBe(1);
  first.dispose();
  const reloaded = new PendingLeaves(() => {}); queues.push(reloaded);
  await reloaded.retry();
  expect(reloaded.count).toBe(1);
  acknowledge = true;
  await reloaded.retry();
  expect(reloaded.count).toBe(0);
  expect(requests).toEqual(['alex.old', 'alex.old', 'alex.old']);
  expect(persistedAtSend).toEqual([true, true, true]);
});

it('bounds unanswered Leave HTTP and recovers the same target on reachability without losing intent', async () => {
  vi.useFakeTimers();
  const fetchHTTP = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  vi.stubGlobal('fetch', fetchHTTP);
  const pending = new PendingLeaves(() => {}); queues.push(pending);
  const leaving = pending.add('alex.unanswered');
  expect(pending.count).toBe(1);
  await vi.advanceTimersByTimeAsync(10_000);
  await leaving;
  expect(pending.count).toBe(1);
  fetchHTTP.mockImplementationOnce(async () => Response.json({ revoked: true }));
  window.dispatchEvent(new Event('online'));
  await pending.retry();
  expect(pending.count).toBe(0);
  expect(fetchHTTP).toHaveBeenCalledTimes(2);
  expect(fetchHTTP.mock.calls[1]![1].body).toBe(JSON.stringify({ grantId: 'alex.unanswered' }));
});

it('retries exact persisted intent after a lost acknowledgement and reload', async () => {
  const fetchHTTP = vi.fn().mockRejectedValueOnce(new TypeError('Response lost')).mockResolvedValue(Response.json({ revoked: true }));
  vi.stubGlobal('fetch', fetchHTTP);
  const oldPage = new PendingLeaves(() => {}); queues.push(oldPage);
  await oldPage.add('alex.lost-response');
  expect(oldPage.count).toBe(1);
  oldPage.dispose();
  const newPage = new PendingLeaves(() => {}); queues.push(newPage);
  await newPage.retry();
  expect(newPage.count).toBe(0);
  expect(fetchHTTP.mock.calls.map((call) => JSON.parse(call[1].body).grantId)).toEqual(['alex.lost-response', 'alex.lost-response']);
});

it('resumes a pending Leave when the browser restores a page from its back/forward cache', async () => {
  const fetchHTTP = vi.fn().mockRejectedValueOnce(new TypeError('Offline')).mockResolvedValue(Response.json({ revoked: true }));
  vi.stubGlobal('fetch', fetchHTTP);
  const pending = new PendingLeaves(() => {}); queues.push(pending);
  await pending.add('alex.cached-page');
  window.dispatchEvent(new Event('pagehide'));
  window.dispatchEvent(new Event('pageshow'));
  await pending.retry();
  expect(pending.count).toBe(0);
});
