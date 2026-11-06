import type { Preview } from '@storybook/react-vite';
import '@fontsource-variable/onest/index.css';
import '../src/styles.css';
import './preview.css';
import { setLanguage } from '../src/strings';

const preview: Preview = {
  globalTypes: {
    theme: { description: 'Canvas theme', toolbar: { icon: 'circlehollow', items: ['dark', 'light'], dynamicTitle: true } },
    language: { description: 'Interface language', toolbar: { icon: 'globe', items: [{ value: 'uk', title: 'Українська' }, { value: 'en', title: 'English' }], dynamicTitle: true } },
  },
  initialGlobals: { theme: 'dark', language: 'uk' },
  parameters: { layout: 'padded', controls: { expanded: true } },
  decorators: [(Story, context) => {
    const language = context.globals.language === 'en' ? 'en' : 'uk';
    // Apply only the presentation layer: importing app/appearance also loads preferences.
    setLanguage(language);
    document.documentElement.lang = language;
    document.documentElement.dataset.theme = context.globals.theme === 'light' ? 'light' : 'dark';
    return <div className="sb-canvas"><Story /></div>;
  }],
};
export default preview;
