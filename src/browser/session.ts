import { MockBrowserDriver, mockDemoPages } from "./adapters/mockDriver";
import type { SteelPageLike } from "./adapters/steelDriver";
import { SteelBrowserDriver } from "./adapters/steelDriver";
import { ProvenanceLog } from "./provenance";
import { RecordingBrowserDriver } from "./recordingDriver";
import type { BrowserSession } from "./types";

export type InvestigationBrowserKind = "mock" | "steel";

/**
 * Create a recording session: vendor driver underneath, provenance on top.
 */
export function createInvestigationBrowser(
  kind: InvestigationBrowserKind,
  options?: { page?: SteelPageLike },
): { driver: BrowserSession; log: ProvenanceLog } {
  const log = new ProvenanceLog();
  const inner: BrowserSession =
    kind === "steel"
      ? new SteelBrowserDriver(requireSteelPage(options?.page))
      : new MockBrowserDriver();

  return {
    driver: new RecordingBrowserDriver(inner, log),
    log,
  };
}

function requireSteelPage(page?: SteelPageLike): SteelPageLike {
  if (!page) {
    throw new Error(
      "Steel driver requested but no Playwright/Steel page was provided",
    );
  }
  return page;
}

/**
 * Seed a demo investigation by walking the mock browser through the layer.
 * All evidence later comes from `log`, not from Steel.
 */
export async function runMockInvestigationSeed(
  driver: BrowserSession,
  log: ProvenanceLog,
): Promise<ProvenanceLog> {
  const pages = mockDemoPages();
  for (const page of pages) {
    await driver.navigate(page.url);
    await driver.click(page.title);
    const text = await driver.extract(`extract visible text from ${page.title}`);
    const shot = await driver.screenshot(page.title);
    const shotEntry = [...log.all()]
      .reverse()
      .find((e) => e.screenshotId === shot.id);
    if (shotEntry) {
      log.annotate(shotEntry.id, {
        finding: page.finding,
        label: page.title,
        tone: page.tone,
        highlight: page.highlight,
        extractedPreview: text,
      });
    }
  }
  return log;
}
