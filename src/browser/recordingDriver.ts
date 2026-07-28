import type { ProvenanceLog } from "./provenance";
import type {
  BrowserDriver,
  BrowserScreenshot,
  BrowserSession,
} from "./types";

/**
 * Decorator: every call hits the inner driver, then lands in the provenance log.
 * Handy orchestration should use this wrapper, never the vendor driver directly.
 */
export class RecordingBrowserDriver implements BrowserSession {
  constructor(
    private readonly inner: BrowserDriver,
    private readonly log: ProvenanceLog,
  ) {}

  async navigate(url: string): Promise<void> {
    await this.inner.navigate(url);
    const current = await this.safeUrl(url);
    this.log.append(current, { kind: "navigate", url });
  }

  async click(target: string): Promise<void> {
    await this.inner.click(target);
    const url = await this.safeUrl("");
    this.log.append(url, { kind: "click", target });
  }

  async extract(instruction: string): Promise<string> {
    const text = await this.inner.extract(instruction);
    const url = await this.safeUrl("");
    this.log.append(url, { kind: "extract", instruction, text });
    return text;
  }

  async screenshot(label?: string): Promise<BrowserScreenshot> {
    const shot = await this.inner.screenshot(label);
    const url = await this.safeUrl("");
    this.log.append(
      url,
      { kind: "screenshot", label, screenshotId: shot.id },
      {
        screenshotId: shot.id,
        meta: {
          tone: shot.tone,
          highlight: shot.highlight,
          label: shot.label ?? label,
          dataUrl: shot.dataUrl,
        },
      },
    );
    return shot;
  }

  currentUrl(): Promise<string> {
    return this.inner.currentUrl();
  }

  async close(): Promise<void> {
    const maybe = this.inner as BrowserSession;
    if (maybe.close) await maybe.close();
  }

  private async safeUrl(fallback: string): Promise<string> {
    try {
      return await this.inner.currentUrl();
    } catch {
      return fallback;
    }
  }
}
