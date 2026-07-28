import type { BrowserAction, ProvenanceEntry } from "./types";

let entrySeq = 0;

function nextId(prefix: string): string {
  entrySeq += 1;
  return `${prefix}_${entrySeq.toString(36)}`;
}

/**
 * Append-only action log. Investigation replay + evidence are projections of this,
 * not of Steel (or any other vendor) internals.
 */
export class ProvenanceLog {
  private readonly startedAt = Date.now();
  private readonly entries: ProvenanceEntry[] = [];
  private listeners = new Set<() => void>();

  get startMs(): number {
    return this.startedAt;
  }

  all(): readonly ProvenanceEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries.length = 0;
    this.emit();
  }

  append(
    url: string,
    action: BrowserAction,
    extras?: Pick<ProvenanceEntry, "screenshotId" | "meta">,
  ): ProvenanceEntry {
    const entry: ProvenanceEntry = {
      id: nextId("prov"),
      t: Date.now() - this.startedAt,
      url,
      action,
      screenshotId: extras?.screenshotId,
      meta: extras?.meta,
    };
    this.entries.push(entry);
    this.emit();
    return entry;
  }

  /** Merge extra meta onto an existing entry (e.g. finding notes). */
  annotate(entryId: string, meta: Record<string, unknown>): void {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) return;
    entry.meta = { ...entry.meta, ...meta };
    this.emit();
  }

  /** Restore entries from Handy session storage (keeps original ids/timestamps). */
  hydrate(entries: readonly ProvenanceEntry[]): void {
    this.entries.length = 0;
    for (const entry of entries) {
      this.entries.push({ ...entry, meta: entry.meta ? { ...entry.meta } : undefined });
    }
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export function formatProvenanceTime(tMs: number): string {
  const totalSec = Math.max(0, Math.floor(tMs / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
