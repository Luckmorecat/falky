import { useEffect } from 'react';
import { preloadVoice } from '@falky/voice';
import { createRoot } from 'react-dom/client';
import { applyAppearance } from './appearance';
import { boot } from './controller';
import { captureEntryLinks } from './entryLinks';
import { installInterfaceSounds } from './interfaceSounds';
import { useApp } from './store';
import { Main } from '../ui/Main';
import { Entry } from '../ui/Screens';
import { AccountFlowProvider, useAccountUI } from '../ui/AccountFlow';
import { ToastHost } from '../ui/Toast';

function Screen() {
  const phase = useApp((s) => s.phase);
  const ownerRevision = useApp(s => s.ownerRevision);
  const paused = useApp(s => s.sessionPaused);
  const accountUI = useAccountUI();
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

  return (
    <ToastHost inert={phase === 'ready' && (paused || accountUI.locked)}>
      {phase === 'loading' ? <div className="screen" /> : phase === 'ready' ? <Main key={ownerRevision} /> : <Entry />}
    </ToastHost>
  );
}

function App() {
  useApp((s) => s.settings.language);
  return <AccountFlowProvider><Screen /></AccountFlowProvider>;
}

// A new access link pasted into this tab changes only the fragment.
addEventListener('hashchange', () => {
  captureEntryLinks();
});

applyAppearance();
installInterfaceSounds();
createRoot(document.getElementById('root')!).render(<App />);
void boot();
