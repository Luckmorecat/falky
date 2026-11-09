import { useEffect } from 'react';
import { preloadVoice } from '@falky/voice';
import { createRoot } from 'react-dom/client';
import { applyAppearance } from './appearance';
import { boot } from './controller';
import { installInterfaceSounds } from './interfaceSounds';
import { useApp } from './store';
import { t } from '../strings';
import { Main } from '../ui/Main';
import { Entry } from '../ui/Screens';
import { Message } from '../ui/Message';

function Screen() {
  const phase = useApp((s) => s.phase);
  // Words are read when rendering, so a new language needs only this render.
  useApp((s) => s.settings.language);
  const unread = useApp((s) => Object.values(s.chats).reduce((sum, c) => sum + c.unread, 0));

  useEffect(() => {
    document.title = unread ? `(${unread > 99 ? '99+' : unread}) Falky` : 'Falky';
  }, [unread]);

  useEffect(() => {
    if (phase !== 'entry' && phase !== 'ready') return;
    let frame = 0;
    let observer: PerformanceObserver | undefined;
    function afterPaint() {
      // Also give a newly mounted interface a frame when the page painted earlier.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          // A failed background download must not interrupt chat. Join can retry.
          void preloadVoice().catch(() => {});
        });
      });
    }
    if (typeof PerformanceObserver !== 'undefined'
      && PerformanceObserver.supportedEntryTypes.includes('paint')
      && !performance.getEntriesByName('first-contentful-paint').length) {
      observer = new PerformanceObserver((list) => {
        if (!list.getEntries().some((entry) => entry.name === 'first-contentful-paint')) return;
        observer?.disconnect();
        afterPaint();
      });
      observer.observe({ type: 'paint', buffered: true });
    } else {
      afterPaint();
    }
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [phase]);

  switch (phase) {
    case 'loading':
      return <div className="screen" />;
    case 'entry':
      return <Entry />;
    case 'noaccess':
      return <Message title={t.noAccessTitle} body={t.noAccessBody} />;
    case 'revoked':
      return <Message title={t.revokedTitle} body={t.revokedBody} />;
    case 'ready':
      return <Main />;
  }
}

function App() {
  useApp((s) => s.settings.language);
  return <Screen />;
}

// A new access link pasted into this tab changes only the fragment.
addEventListener('hashchange', () => {
  if (location.hash.includes('k=')) void boot();
});

applyAppearance();
installInterfaceSounds();
createRoot(document.getElementById('root')!).render(<App />);
void boot();
