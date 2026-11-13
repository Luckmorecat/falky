import { beforeEach, expect, it } from 'vitest';
import { setLanguage } from '../strings';
import { requestDevice } from './SignInRequestDetails';

beforeEach(() => setLanguage('en'));
it.each([
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPhone'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X) Mobile/15E148', 'iPad'],
  ['Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile', 'Android phone'],
  ['Mozilla/5.0 (Linux; Android 15; Tablet)', 'Android device'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Windows PC'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X)', 'Mac'],
  ['Mozilla/5.0 (X11; CrOS x86_64)', 'Chromebook'],
  ['Mozilla/5.0 (X11; Linux x86_64)', 'Linux PC'],
  ['', 'Device'],
  ['Some unrecognised browser description', 'Device'],
])('describes %s as %s', (agent, expected) => expect(requestDevice(agent)).toBe(expected));

it('localizes inferred device names', () => {
  setLanguage('uk');
  expect(requestDevice('Windows NT 10.0')).toBe('Комп’ютер Windows');
  expect(requestDevice('')).toBe('Пристрій');
});
