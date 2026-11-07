import { useCallback, useMemo, useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  const list = useMemo(() => matchMedia(query), [query]);
  const subscribe = useCallback((listener: () => void) => {
    list.addEventListener('change', listener);
    return () => list.removeEventListener('change', listener);
  }, [list]);
  return useSyncExternalStore(subscribe, () => list.matches);
}
