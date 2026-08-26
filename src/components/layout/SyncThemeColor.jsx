import { useContext, useEffect } from "react";

import { ColorContext } from "utils/contexts/color";
import { ThemeContext } from "utils/contexts/theme";

// The dashboard (src/pages/index.jsx) syncs the global theme/color contexts
// to whatever settings.yaml configures. Pages that don't otherwise fetch
// settings.yaml server-side (e.g. /widgets, /backups) would fall back to
// ColorContext/ThemeContext's own localStorage-or-default value instead,
// which can visibly differ from the dashboard. Render this once per page,
// passing the same shape getSettings() returns, to keep every page in sync.
export default function SyncThemeColor({ settings }) {
  const { theme, setTheme } = useContext(ThemeContext);
  const { color, setColor } = useContext(ColorContext);

  useEffect(() => {
    if (settings?.theme && theme !== settings.theme) {
      setTheme(settings.theme);
    }
    if (settings?.color && color !== settings.color) {
      setColor(settings.color);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  return null;
}
