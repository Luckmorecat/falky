import { useEffect } from 'react';
import { setChatOpen, stepRoom, voice } from '../app/controller';
import { shortcuts } from '../app/shortcuts';
import { getState, setState } from '../app/store';

/** Installs the app's shortcuts for the lifetime of the main screen. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === shortcuts.closeRooms.key) {
        setState({ roomsOpen: false });
        return;
      }
      const target = e.target as Element | null;
      if (target?.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      // By physical key, so a Ukrainian layout works the same.
      // Straight to writing, as in most chats; a focused button keeps its own Enter.
      if (e.code === shortcuts.chat.code || e.key === shortcuts.chat.key || (e.code === shortcuts.chatEnter.code && !target?.closest('button, a'))) {
        e.preventDefault();
        setChatOpen(true);
        document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
        return;
      }
      if (e.code === shortcuts.mute.code && getState().voice.status === 'connected') void voice.toggleMute();
      else if (e.code === shortcuts.deafen.code && getState().voice.status === 'connected') void voice.toggleDeafen();
      else if (e.code === shortcuts.camera.code && getState().voice.status === 'connected') void voice.toggleCamera();
      else if (e.key === shortcuts.previousRoom.key) stepRoom(-1);
      else if (e.key === shortcuts.nextRoom.key) stepRoom(1);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
}
