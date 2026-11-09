import { describe, expect, it } from 'vitest';
import { createUnreadBeacon } from './unreadBeacon';

describe('unread beacon', () => {
  it('gives an unread message a full arrival cue, then quieter six-second reminders', () => {
    const beacon = createUnreadBeacon();
    expect(beacon.frame('lounge/message-1', 0, false)).toEqual({ phase: 0, strength: 0 });
    expect(beacon.frame('lounge/message-1', 1, false)).toEqual({ phase: 1, strength: 1 });
    expect(beacon.frame('lounge/message-1', 3, false).strength).toBe(0);
    expect(beacon.frame('lounge/message-1', 3, false)).toEqual({ phase: 1, strength: .55 });
  });
  it('restarts for another unread message or room, and stops immediately when read', () => {
    const beacon = createUnreadBeacon();
    beacon.frame('lounge/message-1', 0, false);
    beacon.frame('lounge/message-1', 7, false);
    expect(beacon.frame('lounge/message-2', 0, false)).toEqual({ phase: 0, strength: 0 });
    expect(beacon.frame('lounge/message-2', 1, false).strength).toBe(1);
    expect(beacon.frame(null, .1, false).strength).toBe(0);
    expect(beacon.frame('games/message-3', 0, false)).toEqual({ phase: 0, strength: 0 });
  });

  it('keeps a still accent in reduced motion and does not advance when paused', () => {
    const beacon = createUnreadBeacon();
    expect(beacon.frame('lounge/message-1', 0, true)).toEqual({ phase: -1, strength: .32 });
    expect(beacon.frame('lounge/message-1', 20, true)).toEqual({ phase: -1, strength: .32 });
    expect(beacon.frame(null, 0, true).strength).toBe(0);
    beacon.frame('lounge/message-2', 0, false);
    expect(beacon.frame('lounge/message-2', 1, false)).toEqual(beacon.frame('lounge/message-2', 0, false));
  });
});
