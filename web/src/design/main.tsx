/**
 * The real screens with made-up people, for working on how they look without a
 * server or LiveKit. Open /design.html on the dev server; production never builds it.
 */
import '@fontsource-variable/onest/index.css';
import '../styles.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Message as ChatMessage, Room } from '../api/client';
import { applyAppearance } from '../app/appearance';
import { voice } from '../app/controller';
import { installInterfaceSounds } from '../app/interfaceSounds';
import { getState, setState, useApp } from '../app/store';
import { emptyChat } from '../chat/timeline';
import { hashString, PALETTE_NAMES } from '../fx/palette';
import { t } from '../strings';
import { idleVoice, type VoicePerson, type VoiceSnapshot } from '../voice/types';
import { Main } from '../ui/Main';
import { Orb } from '../ui/Orb';
import { Auth } from '../ui/Screens';
import { Message } from '../ui/Message';

const NAMES = ['Олена', 'Марк', 'Софія', 'Тарас', 'Ірина', 'Богдан', 'Катя', 'Дмитро'];
const person = (i: number): VoicePerson => ({
  id: `01JBX6Z8Q3M5W2K7R9T4V1C0D${i}.design`, visitorId: `01JBX6Z8Q3M5W2K7R9T4V1C0D${i}`, name: NAMES[i]!, local: i === 0, muted: false, deafened: false, sharing: false, shareTrackId: '', camera: false, cameraTrackId: '',
});
const self = person(0);

/** Speech-like loudness: bursts of syllables with pauses, different for each person. */
function fakeLevel(id: string, time: number): number {
  const ph = hashString(id) % 100;
  const turn = Math.sin(time * 0.55 + ph);
  if (turn < 0.15) return 0;
  const syllables = 0.5 + 0.5 * Math.sin(time * 9 + ph) * Math.sin(time * 3.7 + ph * 2);
  return Math.min(1, Math.min(1, (turn - 0.15) * 4) * (0.35 + syllables * 0.6));
}

voice.level = (id) => fakeLevel(id, performance.now() / 1000);

const patchVoice = (patch: Partial<VoiceSnapshot>) => setState({ voice: { ...getState().voice, ...patch } });
const inVoice = (people: VoicePerson[], roomId: string): VoiceSnapshot => ({ ...idleVoice, status: 'connected', roomId, joinedAt: performance.now() - 754_000, people, quality: 'good' });

voice.toggleMute = async () => patchVoice({ muted: !getState().voice.muted });
voice.toggleDeafen = async () => patchVoice({ deafened: !getState().voice.deafened });
voice.toggleShare = async () => patchVoice({ sharing: !getState().voice.sharing });
voice.toggleCamera = async () => {
  const v = getState().voice;
  const camera = !v.camera;
  patchVoice({ camera, people: v.people.map((p) => (p.local ? { ...p, camera, cameraTrackId: camera ? 'fake' : '' } : p)) });
};

/** A moving picture in place of anyone's camera. */
function fakeCamera(): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d')!;
  const paint = () => {
    const t = performance.now() / 1000;
    const sky = ctx.createLinearGradient(0, 0, 0, 360);
    sky.addColorStop(0, '#3b4a63');
    sky.addColorStop(1, '#c9a27e');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 640, 360);
    const x = 320 + Math.sin(t) * 14;
    ctx.fillStyle = '#2a2f3a';
    ctx.beginPath();
    ctx.ellipse(x, 400, 130, 130, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e6bd9c';
    ctx.beginPath();
    ctx.ellipse(x, 170, 62, 78, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  paint();
  setInterval(paint, 66);
  return canvas.captureStream(15);
}
const fakeStream = fakeCamera();
voice.cameraTrack = () => ({
  attach(el: HTMLMediaElement) {
    el.srcObject = fakeStream;
    return el;
  },
  detach() {
    return [];
  },
}) as unknown as ReturnType<typeof voice.cameraTrack>;
voice.leave = async () => setState({ voice: idleVoice });
voice.join = async (roomId) => setState({ voice: inVoice(ROOM_PEOPLE, roomId) });

const ROOM_PEOPLE = [person(0), person(1), { ...person(2), muted: true }, person(3)];
const rooms: Room[] = [
  { id: 'lounge', name: 'Вітальня', occupancy: ROOM_PEOPLE.map((p) => ({ connectionId: p.id, visitorId: p.visitorId, name: p.name })) },
  { id: 'games', name: 'Ігри', occupancy: [person(4), person(5)].map((p) => ({ connectionId: p.id, visitorId: p.visitorId, name: p.name })) },
  { id: 'work', name: 'Робота', occupancy: [] },
];
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const messages: ChatMessage[] = [
  ['Марк', 1, 42, 'Хто сьогодні заходить грати?'],
  ['Софія', 2, 38, 'Я буду після восьмої'],
  ['Софія', 2, 37, 'Тільки мікрофон ще не налаштувала'],
  ['Олена', 0, 12, 'Глянула нові орби, живі якісь'],
].map(([name, i, ago, body], n) => ({ id: `m${n}`, roomId: 'lounge', authorId: person(i as number).visitorId, authorName: name as string, body: body as string, attachments: [], createdAt: minutesAgo(ago as number) }));

const SCENES = {
  orbs: 'Орби',
  voice: 'У голосі',
  listening: 'Поза голосом',
  many: 'Вісім людей',
  share: 'Показ екрана',
  camera: 'Камери',
  chat: 'Чат',
  empty: 'Порожня кімната',
  entry: 'Пароль сервера',
  signin: 'Вхід',
  register: 'Реєстрація',
  recover: 'Відновлення',
  noaccess: 'Сервер не готовий',
  elsewhere: 'Голос в іншій кімнаті',
} as const;
type Scene = keyof typeof SCENES;

function stage(scene: Scene): void {
  const chats = Object.fromEntries(rooms.map((r) => [r.id, { ...emptyChat(), loaded: true, messages: r.id === 'lounge' ? messages : [] }]));
  const many = NAMES.map((_, i) => person(i));
  setState({
    phase: 'ready', visitor: { id: self.visitorId, name: self.name, nameTaken: false, colour: { visitorId: self.visitorId, palette: 'sky', revision: 1 } }, live: 'open', chats, notice: null, roomsOpen: false,
    colours: Object.fromEntries(NAMES.map((_, i) => { const id = person(i).visitorId; return [id, { visitorId: id, palette: PALETTE_NAMES[i % PALETTE_NAMES.length]!, revision: 1 }]; })),
    rooms, viewedRoomId: scene === 'empty' ? 'work' : 'lounge', chatOpen: scene === 'chat', voice: idleVoice,
  });
  if (scene === 'voice' || scene === 'chat') setState({ voice: inVoice(ROOM_PEOPLE, 'lounge') });
  if (scene === 'many') setState({ rooms: [{ ...rooms[0]!, occupancy: many.map((p) => ({ connectionId: p.id, visitorId: p.visitorId, name: p.name })) }, rooms[1]!, rooms[2]!], voice: inVoice(many, 'lounge') });
  if (scene === 'share') setState({ voice: inVoice([{ ...person(1), sharing: true }, ...ROOM_PEOPLE.filter((p) => p.id !== person(1).id)], 'lounge') });
  if (scene === 'camera') setState({ voice: { ...inVoice(ROOM_PEOPLE.map((p, i) => (i < 2 ? { ...p, camera: true, cameraTrackId: 'fake' } : p)), 'lounge'), camera: true } });
  const auth = { guestName: null, reason: null, recovery: null } as const;
  if (scene === 'entry') setState({ phase: 'auth', auth: { ...auth, step: 'access' } });
  if (scene === 'signin') setState({ phase: 'auth', auth: { ...auth, step: 'signin' } });
  if (scene === 'register') setState({ phase: 'auth', auth: { ...auth, step: 'register' } });
  if (scene === 'recover') setState({ phase: 'auth', auth: { ...auth, step: 'recover' } });
  if (scene === 'noaccess') setState({ phase: 'unset' });
  if (scene === 'elsewhere') setState({ viewedRoomId: 'games', voice: inVoice(ROOM_PEOPLE, 'lounge') });
}

let incoming = 0;
/** Someone else writes in the viewed room, to see how the chat tells of it. */
function fakeIncoming(): void {
  const s = getState();
  const id = s.viewedRoomId;
  const chat = id ? s.chats[id] : undefined;
  if (!id || !chat) return;
  const message: ChatMessage = { id: `n${++incoming}`, roomId: id, authorId: person(1).id, authorName: person(1).name, body: 'Заходьте, вже чекаємо', attachments: [], createdAt: new Date().toISOString() };
  setState({ chats: { ...s.chats, [id]: { ...chat, messages: [...chat.messages, message], unread: chat.unread + 1 } } });
}

function OrbSheet() {
  return (
    <div className="screen" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', alignContent: 'center', justifyItems: 'center', gap: 32, padding: '32px 48px' }}>
      {PALETTE_NAMES.map((name, i) => (
        <div key={name} style={{ width: 'min(100%, 34dvh)', display: 'grid', gap: 12, justifyItems: 'center' }}>
          <div style={{ width: '100%' }}>
            <Orb seed={`sheet-${i * 7}`} palette={name} level={i % 2 ? () => fakeLevel(name, performance.now() / 1000) : undefined} />
          </div>
          <span style={{ color: 'var(--text-2)', fontSize: 13 }}>{name}{i % 2 ? ' · говорить' : ''}</span>
        </div>
      ))}
    </div>
  );
}

function Design() {
  const [scene, setScene] = useState<Scene>(() => {
    const asked = new URLSearchParams(location.search).get('scene');
    const first = asked && asked in SCENES ? (asked as Scene) : 'orbs';
    stage(first);
    return first;
  });
  const phase = useApp((s) => s.phase);
  useApp((s) => s.settings.language);
  const pick = (next: Scene) => {
    stage(next);
    setScene(next);
    history.replaceState(null, '', `?scene=${next}`);
  };

  return (
    <>
      {scene === 'orbs' ? <OrbSheet /> : phase === 'auth' ? <Auth /> : phase === 'unset' ? <Message title={t.auth.unsetTitle} body={t.auth.unsetBody} /> : <Main key={scene} />}
      <nav style={{ position: 'fixed', left: 12, bottom: 12, zIndex: 100, display: 'flex', flexDirection: 'column', gap: 2, padding: 6, borderRadius: 16, background: 'rgba(30,30,34,.92)', fontSize: 12 }}>
        {(Object.keys(SCENES) as Scene[]).map((s) => (
          <button key={s} onClick={() => pick(s)} style={{ padding: '5px 10px', borderRadius: 10, textAlign: 'left', background: s === scene ? '#fff' : 'none', color: s === scene ? '#000' : '#fff' }}>{SCENES[s]}</button>
        ))}
        <button onClick={fakeIncoming} style={{ padding: '5px 10px', borderRadius: 10, textAlign: 'left', color: '#fff', opacity: .7 }}>+ повідомлення</button>
      </nav>
    </>
  );
}

applyAppearance();
installInterfaceSounds();
createRoot(document.getElementById('root')!).render(<Design />);
