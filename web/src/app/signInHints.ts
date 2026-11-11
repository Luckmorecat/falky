import type { SignInRequest } from '../api/client';

let hints: readonly SignInRequest[] = [];
const listeners = new Set<() => void>();
export const getSignInHints = (): readonly SignInRequest[] => hints;
export function subscribeSignInHints(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function retainSignInHint(request: SignInRequest): void {
  if (request.type !== 'link' || !request.linkId) return;
  const previous = hints.find(value => value.id === request.id);
  if (previous && previous.version > request.version) return;
  hints = [...hints.filter(value => value.id !== request.id), request].slice(-100);
  listeners.forEach(listener => listener());
}
export function clearSignInHints(): void {
  hints = [];
  listeners.forEach(listener => listener());
}
