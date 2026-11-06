# Frontend workshops

From `web/`, install the locked dependencies with `npm ci`.

- `npm run storybook` starts the component workshop at http://localhost:6006.
- `npm run build-storybook` creates a static workshop in `storybook-static/` (ignored by Git).
- `npm run dev` keeps the existing full-screen playground at http://localhost:5173/design.html. It includes entry, room, chat, sharing, and access-message scenarios.
- `npm run dev:mock` starts the app with simulated services for complete user flows; use the printed URL.

Storybook is local development tooling. It uses Falky's Onest font and production styles. Its toolbar switches light/dark appearance and Ukrainian/English text without writing app preferences. No backend or device permissions are needed.

The initial catalog contains Icon (all glyphs), Orb (palettes, idle, simulated speech, still), Message (informational screens and long text), Button (primary, secondary, join), IconButton (sizes and pressed states), Toggle, and Segmented. Interactive stories show their actions and current values in the canvas; static state stories can be adjusted through Controls where applicable. The full-screen playground remains separate.

To add an example, create `stories/Name.stories.tsx`, import a pure production component from `src/ui`, and export a typed `Meta` plus named `StoryObj` examples. Add `tags: ['autodocs']` for a component reference page. Read `t` from `src/strings` inside render functions for toolbar-aware labels. Keep state and event feedback local to the story; never import the app controller, store, preference adapters or voice session. The preview deliberately uses its own Vite config, so it cannot inherit backend proxies or initialize application adapters.

There is no Storybook test runner, interaction-test suite, visual regression service, or CI gate. The build command produces an optional local artifact; it does not publish anything.
