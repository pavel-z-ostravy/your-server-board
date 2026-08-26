import classNames from "classnames";
import { useContext, useEffect } from "react";

import { ColorContext } from "utils/contexts/color";
import { ThemeContext } from "utils/contexts/theme";

// Renders the dashboard's wallpaper background (settings.yaml's `background`
// block) plus its backdrop blur/saturate/brightness, and keeps <html>'s
// theme/scheme/color classes in sync with settings.yaml. Originally this
// lived only in src/pages/index.jsx's own "Wrapper" component, so every other
// page rendered on a flat background with no wallpaper and a possibly wrong
// color swatch. Wrap a page's content with this to match the dashboard
// exactly - src/pages/index.jsx uses it too, so there's a single copy of
// this logic instead of one per page.
export default function PageBackground({ initialSettings, children }) {
  const { theme } = useContext(ThemeContext);
  const { color } = useContext(ColorContext);

  let backgroundImage = "";
  let opacity = initialSettings?.backgroundOpacity ?? 0;
  let backgroundBlur = false;
  let backgroundSaturate = false;
  let backgroundBrightness = false;
  if (initialSettings?.background) {
    const bg = initialSettings.background;
    if (typeof bg === "object") {
      backgroundImage = bg.image || "";
      if (bg.opacity !== undefined) {
        opacity = 1 - bg.opacity / 100;
      }
      backgroundBlur = bg.blur !== undefined;
      backgroundSaturate = bg.saturate !== undefined;
      backgroundBrightness = bg.brightness !== undefined;
    } else {
      backgroundImage = bg;
    }
  }

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;

    html.classList.remove("dark", "scheme-dark", "scheme-light");
    html.classList.toggle("dark", theme === "dark");
    html.classList.add(theme === "dark" ? "scheme-dark" : "scheme-light");

    const desiredThemeClass = `theme-${color || initialSettings?.color || "slate"}`;
    const themeClassesToRemove = Array.from(html.classList).filter(
      (cls) => cls.startsWith("theme-") && cls !== desiredThemeClass,
    );
    if (themeClassesToRemove.length) {
      html.classList.remove(...themeClassesToRemove);
    }
    if (!html.classList.contains(desiredThemeClass)) {
      html.classList.add(desiredThemeClass);
    }

    // Remove any previously applied inline styles
    body.style.backgroundImage = "";
    body.style.backgroundColor = "";
    body.style.backgroundAttachment = "";
  }, [backgroundImage, opacity, theme, color, initialSettings?.color]);

  return (
    <>
      {backgroundImage && (
        <div
          id="background"
          aria-hidden="true"
          style={{
            backgroundImage: `linear-gradient(rgb(var(--bg-color) / ${opacity}), rgb(var(--bg-color) / ${opacity})), url('${backgroundImage}')`,
          }}
        />
      )}
      <div id="page_wrapper" className="relative h-full">
        <div
          id="inner_wrapper"
          tabIndex="-1"
          className={classNames(
            "w-full h-full overflow-auto",
            backgroundBlur &&
              `backdrop-blur${initialSettings.background.blur?.length ? `-${initialSettings.background.blur}` : ""}`,
            backgroundSaturate && `backdrop-saturate-${initialSettings.background.saturate}`,
            backgroundBrightness && `backdrop-brightness-${initialSettings.background.brightness}`,
          )}
        >
          {children}
        </div>
      </div>
    </>
  );
}
