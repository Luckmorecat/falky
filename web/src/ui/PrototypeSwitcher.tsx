import { useEffect, type ReactNode } from 'react';
import { Icon } from './Icon';

export function PrototypeSwitcher({ variants, current, onChange, children }: {
  variants: readonly { key: string; name: string }[];
  current: string;
  onChange(key: string): void;
  children?: ReactNode;
}) {
  const cycle = (direction: number) => {
    const index = variants.findIndex(item => item.key === current);
    onChange(variants[(index + direction + variants.length) % variants.length]!.key);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable], [role="slider"]'))) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        cycle(event.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });
  if (!import.meta.env.DEV) return null;
  const variant = variants.find(item => item.key === current)!;
  return <nav className="prototype-switcher" aria-label="Prototype variants">
    <button aria-label="Previous variant" onClick={() => cycle(-1)}><Icon name="left" /></button>
    <span aria-live="polite"><b>{variant.key}</b> {variant.name}</span>
    <button aria-label="Next variant" onClick={() => cycle(1)}><Icon name="right" /></button>
    {children}
  </nav>;
}
