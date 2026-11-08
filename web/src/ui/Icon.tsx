import type { ReactNode } from 'react';

const PATHS = {
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" /></>,
  micOff: <path d="M15 9.5V6a3 3 0 0 0-5.6-1.5M9 9v2a3 3 0 0 0 4.6 2.5M5.5 11.5a6.5 6.5 0 0 0 10.4 5.2M18.5 11.5c0 .8-.1 1.5-.4 2.2M12 18v3M4 4l16 16" />,
  speakerOff: <><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="m16 9 6 6m0-6-6 6" /></>,
  head: <><path d="M4 15v-3a8 8 0 0 1 16 0v3" /><rect x="3.5" y="14" width="4" height="6.5" rx="1.8" /><rect x="16.5" y="14" width="4" height="6.5" rx="1.8" /></>,
  headOff: <path d="M4 15v-3c0-1.500.4-2.900 1.100-4.100M8.300 4.900A8 8 0 0 1 20 12v3M3.500 16v2.700c0 1 .8 1.800 1.800 1.800h.4c1 0 1.800-.8 1.800-1.800V16a2 2 0 0 0-2-2 2 2 0 0 0-2 2ZM16.500 16.500v2.200c0 1 .8 1.800 1.800 1.800M3 3l18 18" />,
  screen: <><rect x="3" y="4.500" width="18" height="12.500" rx="3" /><path d="M9 20.500h6M12 13V8.500M9.500 10.500 12 8l2.500 2.500" /></>,
  camera: <><rect x="3" y="6" width="13" height="12" rx="3" /><path d="m16 10.500 5-3v9l-5-3" /></>,
  sliders: <><path d="M5 7h8M17 7h2M5 17h2M11 17h8" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  check: <path d="m5.500 12.500 4.500 4.500 8.500-9.500" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  chat: <path d="M12 4c4.700 0 8.500 3.300 8.500 7.500S16.700 19 12 19c-1 0-2-.15-2.900-.45L4.500 20l1.200-3.700C4.300 15 3.500 13.300 3.500 11.500 3.500 7.300 7.300 4 12 4Z" />,
  send: <path d="M12 19V6M6.500 11 12 5.500l5.500 5.500" />,
  down: <path d="M12 5v13M6.500 13 12 18.500l5.500-5.500" />,
  chevron: <path d="M6.500 9.500 12 15l5.500-5.500" />,
  expand: <path d="M4.500 9V4.500H9M15 4.500h4.500V9M19.500 15v4.500H15M9 19.500H4.500V15" />,
  collapse: <path d="M9 4.500V9H4.500M15 4.500V9h4.500M19.500 15H15v4.500M4.500 15H9v4.500" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg className={`i ${className}`} viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
