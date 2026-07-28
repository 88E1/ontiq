import type {
  BrowserDriver,
  BrowserScreenshot,
  BrowserSession,
  HighlightBox,
} from "../types";

type MockPage = {
  url: string;
  title: string;
  bodyText: string;
  tone: string;
  highlight: HighlightBox;
  finding?: string;
};

const DEMO_PAGES: MockPage[] = [
  {
    url: "https://app.example.com/login",
    title: "Login form error",
    bodyText:
      "Invalid credentials. Please check your email and password and try again.",
    tone: "#3a4554",
    highlight: { x: 18, y: 42, w: 64, h: 18 },
    finding: "Auth error surfaced after submit with no recovery path.",
  },
  {
    url: "https://app.example.com/settings/notifications",
    title: "Settings toggle mismatch",
    bodyText:
      "Email notifications: On\nPush notifications: Off\nWeekly digest: On",
    tone: "#3d4a3f",
    highlight: { x: 52, y: 28, w: 36, h: 22 },
    finding: "Toggle state in UI does not match saved preference.",
  },
  {
    url: "https://app.example.com/checkout",
    title: "Checkout total jump",
    bodyText: "Subtotal $48.00\nTax $3.84\nTotal $61.20",
    tone: "#4a3f3a",
    highlight: { x: 60, y: 58, w: 28, h: 14 },
    finding: "Displayed total does not equal subtotal + tax.",
  },
  {
    url: "https://app.example.com/projects",
    title: "Empty state flash",
    bodyText: "No projects yet. Create your first project to get started.",
    tone: "#3a3f4a",
    highlight: { x: 22, y: 36, w: 56, h: 24 },
    finding: "Empty state briefly appears even when projects exist.",
  },
];

let shotSeq = 0;

/**
 * In-process fake browser for UI / provenance demos.
 * Swap for {@link SteelBrowserDriver} when a real Steel session is available.
 */
export class MockBrowserDriver implements BrowserSession {
  private index = 0;

  private page(): MockPage {
    return DEMO_PAGES[this.index] ?? DEMO_PAGES[0];
  }

  async navigate(url: string): Promise<void> {
    const i = DEMO_PAGES.findIndex(
      (p) => p.url === url || url.includes(new URL(p.url).pathname),
    );
    this.index = i >= 0 ? i : Math.min(this.index + 1, DEMO_PAGES.length - 1);
  }

  async click(_target: string): Promise<void> {
    this.index = Math.min(this.index + 1, DEMO_PAGES.length - 1);
  }

  async extract(_instruction: string): Promise<string> {
    return this.page().bodyText;
  }

  async screenshot(label?: string): Promise<BrowserScreenshot> {
    shotSeq += 1;
    const page = this.page();
    return {
      id: `shot_${shotSeq}`,
      tone: page.tone,
      highlight: page.highlight,
      label: label ?? page.title,
    };
  }

  async currentUrl(): Promise<string> {
    return this.page().url;
  }

  async close(): Promise<void> {
    // no-op
  }

  /** Demo helper: metadata the mock pages carry for findings. */
  pageMeta(): { title: string; finding?: string } {
    const p = this.page();
    return { title: p.title, finding: p.finding };
  }
}

export function mockDemoPages(): readonly MockPage[] {
  return DEMO_PAGES;
}
