import { useSyncExternalStore } from 'react';

/** Too narrow for the chat beside the stage, or no mouse to bring it forward: it becomes a drawer. */
const query = matchMedia('(max-width: 1180px), (hover: none)');

export function useDrawerLayout(): boolean {
  return useSyncExternalStore(
    (listener) => {
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    },
    () => query.matches,
  );
}
