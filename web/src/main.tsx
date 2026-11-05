import '@fontsource-variable/onest/index.css';
import './styles.css';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { applyAppearance } from './app/appearance';
import { boot } from './app/controller';
import { useApp } from './app/store';
import { t } from './strings';
import { Main } from './ui/Main';
import { Entry, Message } from './ui/Screens';

function App() {
  const phase = useApp((s) => s.phase);
  // Words are read when rendering, so a new language needs only this render.
  useApp((s) => s.settings.lang);
  const fewerEffects = useApp((s) => s.settings.fewerEffects);
  const unread = useApp((s) => Object.values(s.chats).reduce((sum, c) => sum + c.unread, 0));

  useEffect(() => {
    document.body.classList.toggle('reduced', fewerEffects);
  }, [fewerEffects]);

  useEffect(() => {
    document.title = unread ? `(${unread > 99 ? '99+' : unread}) Falky` : 'Falky';
  }, [unread]);

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

// A new access link pasted into this tab changes only the fragment.
addEventListener('hashchange', () => {
  if (location.hash.includes('k=')) void boot();
});

applyAppearance();
createRoot(document.getElementById('root')!).render(<App />);
void boot();
