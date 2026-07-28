import { listen } from "@tauri-apps/api/event";
import { commands, type InvestigationSession } from "@/bindings";
import {
  evidenceFromProvenance,
  eventLogFromProvenance,
  type EventLogItem,
  type EvidenceItem,
} from "./evidence";
import {
  parseIntegrityJson,
  type InvestigationIntegrity,
} from "./integrity";
import { ProvenanceLog } from "./provenance";
import type { ProvenanceEntry } from "./types";

export const DEFAULT_INVESTIGATION_TITLE = "Investigation";

function logFromEntries(entries: ProvenanceEntry[]): ProvenanceLog {
  const log = new ProvenanceLog();
  log.hydrate(entries);
  return log;
}

function parseEntries(entriesJson: string): ProvenanceEntry[] {
  try {
    const parsed = JSON.parse(entriesJson) as unknown;
    return Array.isArray(parsed) ? (parsed as ProvenanceEntry[]) : [];
  } catch {
    return [];
  }
}

export async function loadInvestigationSession(): Promise<InvestigationSession | null> {
  try {
    return await commands.getInvestigationSession();
  } catch {
    return null;
  }
}

export async function saveInvestigationSession(
  session: InvestigationSession,
): Promise<void> {
  const result = await commands.saveInvestigationSession(session);
  if (result.status === "error") {
    throw new Error(String(result.error));
  }
}

export async function clearInvestigationSession(): Promise<void> {
  const result = await commands.clearInvestigationSession();
  if (result.status === "error") {
    throw new Error(String(result.error));
  }
}

/**
 * Load the latest agent investigation session, if any.
 * Does not invent mock evidence - empty means no run yet.
 */
export async function ensureInvestigationSession(): Promise<InvestigationSession | null> {
  const existing = await loadInvestigationSession();
  if (existing && parseEntries(existing.entries_json).length > 0) {
    return existing;
  }
  return existing;
}

export function entriesFromSession(
  session: InvestigationSession | null,
): ProvenanceEntry[] {
  if (!session) return [];
  return parseEntries(session.entries_json);
}

export function evidenceFromSession(
  session: InvestigationSession | null,
): EvidenceItem[] {
  if (!session) return [];
  const entries = parseEntries(session.entries_json);
  return evidenceFromProvenance(logFromEntries(entries));
}

export function eventLogFromSession(
  session: InvestigationSession | null,
): EventLogItem[] {
  if (!session) return [];
  const entries = parseEntries(session.entries_json);
  return eventLogFromProvenance(logFromEntries(entries));
}

export function integrityFromSession(
  session: InvestigationSession | null,
): InvestigationIntegrity | null {
  if (!session) return null;
  return parseIntegrityJson(session.integrity_json);
}

export function subscribeInvestigationUpdates(
  onUpdate: (session: InvestigationSession | null) => void,
): Promise<() => void> {
  return (async () => {
    // Event payload may be a light ping (empty entries_json) to avoid shipping
    // multi-MB screenshot blobs over the event bus - always refetch.
    const unUpdated = await listen("investigation-updated", () => {
      void loadInvestigationSession().then(onUpdate);
    });
    const unCleared = await listen("investigation-cleared", () =>
      onUpdate(null),
    );
    return () => {
      unUpdated();
      unCleared();
    };
  })();
}
