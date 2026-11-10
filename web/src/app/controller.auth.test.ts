import { beforeEach, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({
  api: {
    access: vi.fn(), passAccess: vi.fn(), login: vi.fn(), register: vi.fn(), recover: vi.fn(), logout: vi.fn(),
    me: vi.fn(), rooms: vi.fn(), messages: vi.fn(), colours: vi.fn(), attachmentLimits: vi.fn(), createRoom: vi.fn(), renameRoom: vi.fn(),
  },
}));
vi.mock('../api/client', async (original) => ({ ...await original<typeof import('../api/client')>(), api: seam.api }));
vi.mock('../api/live', () => ({ LiveConnection: class { start() {} stop() {} } }));
vi.mock('@falky/voice', () => ({ VoiceSession: class { end() {} } }));
vi.mock('@falky/browser', () => ({}));
vi.mock('./appearance', () => ({ applyAppearance() {} }));

const alex = { id: 'alex', name: 'Alex', nameTaken: false, colour: { visitorId: 'alex', palette: 'sky' as const, revision: 1 } };
const enrolled = () => ({ session: { visitor: alex, kind: 'account' as const } });

async function load() {
  const { ApiError } = await import('../api/client');
  const app = await import('./controller');
  const { getState } = await import('./store');
  return { app, getState, refuse: (status: number, code: string) => new ApiError(status, code, code) };
}

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); localStorage.clear(); history.replaceState(null, '', '/');
  seam.api.rooms.mockResolvedValue([]); seam.api.messages.mockResolvedValue([]); seam.api.colours.mockResolvedValue([]);
  seam.api.attachmentLimits.mockResolvedValue({ maxAttachments: 4, maxFileBytes: 1 });
});

it('asks for the access password first, then signs in and maps refusals to the field they are about', async () => {
  const { app, getState, refuse } = await load();
  seam.api.me.mockRejectedValue(refuse(401, 'visitor_required'));
  seam.api.access.mockResolvedValue({ passwordSet: true, passed: false });
  await app.boot();
  expect(getState()).toMatchObject({ phase: 'auth', auth: { step: 'access' } });

  // Without the pass, other steps lead back to the access password.
  app.goTo('register');
  expect(getState().auth.step).toBe('access');

  seam.api.passAccess.mockRejectedValueOnce(refuse(403, 'invalid_access_password'));
  expect(await app.passAccess('wrong')).toMatchObject({ field: 'password' });
  seam.api.passAccess.mockResolvedValueOnce({ passwordSet: true, passed: true });
  expect(await app.passAccess('right')).toBeNull();
  expect(getState().auth.step).toBe('signin');

  seam.api.login.mockRejectedValueOnce(refuse(401, 'invalid_credentials'));
  expect(await app.signIn('alex', 'wrong')).toEqual({ code: 'invalid_credentials', message: expect.any(String) });
  seam.api.login.mockResolvedValueOnce(enrolled());
  expect(await app.signIn('alex', 'right')).toBeNull();
  expect(getState()).toMatchObject({ phase: 'ready', visitor: { id: 'alex' } });
});

it('registers straight into the app and maps refusals to the field they are about', async () => {
  const { app, getState, refuse } = await load();
  seam.api.me.mockRejectedValue(refuse(401, 'visitor_required'));
  seam.api.access.mockResolvedValue({ passwordSet: true, passed: true });
  await app.boot();
  app.goTo('register');
  expect(getState().auth.step).toBe('register');
  seam.api.register.mockRejectedValueOnce(refuse(409, 'login_taken'));
  expect(await app.register('alex', 'password1', 'Alex')).toMatchObject({ field: 'login' });
  seam.api.register.mockResolvedValueOnce(enrolled());
  expect(await app.register('alex', 'password1', 'Alex')).toBeNull();
  expect(getState()).toMatchObject({ phase: 'ready', visitor: { id: 'alex' } });
});

it('lets a legacy guest register without the access password, and says when the server is not set up', async () => {
  const { app, getState, refuse } = await load();
  seam.api.me.mockRejectedValue(refuse(401, 'visitor_required'));
  seam.api.access.mockResolvedValueOnce({ passwordSet: true, passed: false, guestName: 'Bob' });
  await app.boot();
  expect(getState()).toMatchObject({ phase: 'auth', auth: { step: 'register', guestName: 'Bob' } });
  seam.api.access.mockResolvedValueOnce({ passwordSet: false, passed: false });
  await app.boot();
  expect(getState().phase).toBe('unset');
});

it('opens recovery from an operator link and asks for a login when the account has none', async () => {
  history.replaceState(null, '', '/#recover=CODE&account=01ACCOUNT');
  const { app, getState, refuse } = await load();
  seam.api.me.mockRejectedValue(refuse(401, 'visitor_required'));
  seam.api.access.mockResolvedValue({ passwordSet: true, passed: true });
  await app.boot();
  expect(location.hash).toBe('');
  expect(getState()).toMatchObject({ auth: { step: 'recover', recovery: { code: 'CODE', account: '01ACCOUNT' } } });
  seam.api.recover.mockRejectedValueOnce(refuse(400, 'login_required'));
  expect(await app.recoverAccount('01ACCOUNT', 'CODE', 'password1')).toMatchObject({ field: 'login' });
  seam.api.recover.mockResolvedValueOnce(enrolled());
  expect(await app.recoverAccount('01ACCOUNT', 'CODE', 'password1', 'alex')).toBeNull();
  expect(seam.api.recover).toHaveBeenLastCalledWith('01ACCOUNT', 'CODE', 'password1', 'alex');
  expect(getState()).toMatchObject({ phase: 'ready', auth: { recovery: null } });
});

it('signs out to the sign-in screen and a lost pass sends the person back to the access password', async () => {
  const { app, getState, refuse } = await load();
  seam.api.me.mockResolvedValue(alex);
  seam.api.access.mockResolvedValue({ passwordSet: true, passed: true });
  await app.boot();
  seam.api.logout.mockResolvedValueOnce(undefined);
  await app.logout();
  await vi.waitFor(() => expect(getState().auth).toMatchObject({ step: 'signin', reason: 'signedOut' }));
  seam.api.login.mockRejectedValueOnce(refuse(403, 'access_required'));
  expect(await app.signIn('alex', 'password1')).toBeNull();
  expect(getState().auth.step).toBe('access');
});

it('creates a room and goes to it, and reports why a name is refused', async () => {
  const { app, getState, refuse } = await load();
  seam.api.me.mockResolvedValue(alex);
  seam.api.rooms.mockResolvedValue([{ id: 'lounge', name: 'Lounge', occupancy: [] }]);
  await app.boot();
  seam.api.createRoom.mockRejectedValueOnce(refuse(409, 'room_name_taken'));
  expect(await app.createRoom('lounge')).toEqual(expect.any(String));
  seam.api.createRoom.mockResolvedValueOnce({ id: 'games', name: 'Games', occupancy: [] });
  expect(await app.createRoom('Games')).toBeNull();
  expect(getState().rooms.map((r) => r.name)).toEqual(['Lounge', 'Games']);
  expect(getState().viewedRoomId).toBe('games');
  seam.api.renameRoom.mockResolvedValueOnce({ id: 'games', name: 'Board games', occupancy: [] });
  expect(await app.renameRoom('games', 'Board games')).toBeNull();
  expect(getState().rooms.map((r) => r.name)).toEqual(['Lounge', 'Board games']);
});
