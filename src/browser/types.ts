/**
 * Tiny swappable browser layer for Handy investigations.
 *
 * Handy (mic + orchestration) talks only to {@link BrowserDriver}.
 * Replay / evidence read {@link ProvenanceLog}, never a vendor SDK.
 * Steel / Playwright (or a mock) plugs in behind the driver.
 *
 * @see https://github.com/steel-dev/steel-browser
 * @see https://docs.steel.dev/
 */

export type HighlightBox = {
  /** Percent of viewport (0-100). */
  x: number;
  y: number;
  w: number;
  h: number;
};

export type BrowserScreenshot = {
  id: string;
  /** Data URL or asset path - UI may treat as opaque. */
  dataUrl?: string;
  /** Placeholder tint when no real pixels yet. */
  tone?: string;
  highlight?: HighlightBox;
  label?: string;
};

/** High-level actions Handy records for every browser call. */
export type BrowserAction =
  | { kind: "navigate"; url: string }
  | { kind: "click"; target: string }
  | { kind: "extract"; instruction: string; text: string }
  | { kind: "screenshot"; label?: string; screenshotId: string };

export type ProvenanceEntry = {
  id: string;
  /** Milliseconds since session start. */
  t: number;
  url: string;
  action: BrowserAction;
  screenshotId?: string;
  /** Free-form notes (finding hints, model ids, etc.). */
  meta?: Record<string, unknown>;
};

/**
 * Minimal surface Handy needs. Keep this small so adapters stay thin.
 */
export interface BrowserDriver {
  navigate(url: string): Promise<void>;
  /** Natural-language or selector target - adapter decides how to resolve. */
  click(target: string): Promise<void>;
  extract(instruction: string): Promise<string>;
  screenshot(label?: string): Promise<BrowserScreenshot>;
  currentUrl(): Promise<string>;
}

/** Optional handle to tear down vendor sessions. */
export interface BrowserSession extends BrowserDriver {
  close?(): Promise<void>;
}
