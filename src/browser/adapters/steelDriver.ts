import type {
  BrowserDriver,
  BrowserScreenshot,
  BrowserSession,
} from "../types";

/**
 * Minimal Playwright/Steel page shape we depend on.
 * The real session lives in the agent-runner sidecar; this adapter lets the
 * frontend browser layer speak the same {@link BrowserDriver} contract.
 */
export type SteelPageLike = {
  goto: (url: string, opts?: { waitUntil?: string }) => Promise<unknown>;
  url: () => string;
  click?: (selector: string) => Promise<unknown>;
  locator?: (selector: string) => {
    first: () => { click: () => Promise<unknown> };
  };
  screenshot?: (opts?: {
    type?: string;
  }) => Promise<Uint8Array | Buffer | ArrayBuffer>;
  evaluate?: (fn: () => string) => Promise<string>;
};

let shotSeq = 0;

/**
 * Steel (Playwright-over-CDP) behind {@link BrowserDriver}.
 * Handy never imports steel-sdk outside the agent-runner / this adapter.
 */
export class SteelBrowserDriver implements BrowserSession {
  constructor(private readonly page: SteelPageLike) {}

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async click(target: string): Promise<void> {
    // Treat target as a CSS selector when possible; otherwise best-effort text.
    if (this.page.click) {
      await this.page.click(target);
      return;
    }
    if (this.page.locator) {
      await this.page.locator(target).first().click();
    }
  }

  async extract(_instruction: string): Promise<string> {
    if (this.page.evaluate) {
      return this.page.evaluate(() => document.body?.innerText?.slice(0, 800) ?? "");
    }
    return this.page.url();
  }

  async screenshot(label?: string): Promise<BrowserScreenshot> {
    shotSeq += 1;
    const id = `shot_st_${shotSeq}`;
    let dataUrl: string | undefined;
    if (this.page.screenshot) {
      const bytes = await this.page.screenshot({ type: "png" });
      dataUrl = bufferToDataUrl(bytes);
    }
    return { id, dataUrl, label };
  }

  async currentUrl(): Promise<string> {
    return this.page.url();
  }

  async close(): Promise<void> {
    // Caller owns Steel / Playwright lifecycle.
  }
}

function bufferToDataUrl(bytes: Uint8Array | Buffer | ArrayBuffer): string {
  const buf =
    bytes instanceof Uint8Array
      ? bytes
      : bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]!);
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

export function createSteelDriver(page: SteelPageLike): BrowserDriver {
  return new SteelBrowserDriver(page);
}
