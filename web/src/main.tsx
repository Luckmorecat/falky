import '@fontsource-variable/onest/index.css';
import './styles.css';
import { bootstrap } from '@falky/bootstrap';
import { showStartupFailure } from './runtime/startup';

// Mock identity/preferences must be ready before store's module initialization.
void bootstrap().then(() => import('./app/render')).catch((error: unknown) => {
  const root = document.getElementById('root');
  if (root) showStartupFailure(root);
  console.error(error);
});
