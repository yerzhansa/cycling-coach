import "../src/theme/fonts.css";
import "../src/theme/tokens.css";
import "../src/theme/tailwind.css";
import "../preview/story.css";
import type { Preview } from "@storybook/react-vite";
import { useEnduragentStore } from "../src/state/store";
import { applyPalette } from "../src/theme/applyPalette";
import { DEFAULT_PALETTE_ID, PALETTES, paletteById } from "../src/theme/palettes";

declare const __PREVIEW_REVISION__: string;

const preview: Preview = {
  initialGlobals: { theme: "light", palette: DEFAULT_PALETTE_ID },
  globalTypes: {
    theme: {
      description: "Appearance",
      toolbar: { icon: "circlehollow", items: ["light", "dark"], dynamicTitle: true },
    },
    palette: {
      description: "Production palette",
      toolbar: {
        icon: "paintbrush",
        items: PALETTES.map(({ id, name }) => ({ value: id, title: name })),
        dynamicTitle: true,
      },
    },
  },
  parameters: { layout: "fullscreen", docs: { story: { inline: false } } },
  beforeEach: () => {
    useEnduragentStore.setState(useEnduragentStore.getInitialState(), true);
  },
  decorators: [
    (Story, context) => {
      const theme: unknown = context.globals.theme;
      const palette: unknown = context.globals.palette;
      if (theme !== "light" && theme !== "dark") throw new Error("Invalid preview theme");
      if (typeof palette !== "string" || !PALETTES.some(({ id }) => id === palette))
        throw new Error("Invalid preview palette");
      applyPalette({
        root: document.documentElement,
        palette: paletteById(palette),
        appearance: theme,
      });
      return (
        <>
          <aside className="story-identity">
            Fictional preview · {context.id} · {__PREVIEW_REVISION__}
          </aside>
          <div
            id="preview-stage"
            data-scenario={context.id}
            data-preview-kind={context.title.startsWith("Shared/") ? "component" : "page"}
          >
            <Story />
          </div>
        </>
      );
    },
  ],
};

export default preview;
