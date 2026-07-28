import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands } from "@/bindings";

/**
 * Syncs the global Handy pin / click-through lock onto `document.documentElement`
 * via the `handy-locked` class (CSS dims the UI). Unlock is shortcut-only.
 */
export function useHandyLock() {
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const initial = await commands.getHandyLocked();
        if (!cancelled) {
          setLocked(Boolean(initial));
          document.documentElement.classList.toggle("handy-locked", Boolean(initial));
        }
      } catch {
        /* command may be unavailable until rebuild */
      }

      unlisten = await listen<boolean>("handy-lock-changed", (event) => {
        const next = Boolean(event.payload);
        setLocked(next);
        document.documentElement.classList.toggle("handy-locked", next);
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      document.documentElement.classList.remove("handy-locked");
    };
  }, []);

  return locked;
}
