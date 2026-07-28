import { formatProvenanceTime, type ProvenanceLog } from "./provenance";
import type { HighlightBox, ProvenanceEntry } from "./types";

/** Workbench evidence card - projection of the provenance log only. */
export type EvidenceItem = {
  id: string;
  title: string;
  timestamp: string;
  /** Host + path for display. */
  source: string;
  /** Full page URL when available. */
  url: string;
  extractedText: string;
  tone: string;
  highlight: HighlightBox;
  finding?: string;
  /** Real PNG/JPEG capture from the agent browser, when present. */
  dataUrl?: string;
  /** Provenance entry ids that produced this card. */
  provenanceIds: string[];
};

const DEFAULT_HIGHLIGHT: HighlightBox = { x: 20, y: 30, w: 50, h: 20 };
const TONES = ["#3a4554", "#3d4a3f", "#4a3f3a", "#3a3f4a", "#403a4a"];

function hostPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url.replace(/^https?:\/\//, "");
  }
}

/**
 * Build evidence moments from the provenance log.
 * Screenshots anchor cards; nearby extract/click/navigate fill text + titles.
 */
export function evidenceFromProvenance(log: ProvenanceLog): EvidenceItem[] {
  const entries = log.all();
  const shots = entries.filter((e) => e.action.kind === "screenshot");

  return shots.map((shot, index) => {
    const meta = shot.meta ?? {};
    const nearby = entries.filter(
      (e) => Math.abs(e.t - shot.t) <= 2_000 || e.url === shot.url,
    );
    const extract = [...nearby]
      .reverse()
      .find((e) => e.action.kind === "extract");
    const click = [...nearby].reverse().find((e) => e.action.kind === "click");

    const extractedText =
      extract && extract.action.kind === "extract"
        ? extract.action.text
        : typeof meta.extractedPreview === "string"
          ? meta.extractedPreview
          : typeof meta.label === "string"
            ? meta.label
            : "";

    const title =
      (typeof meta.label === "string" && meta.label) ||
      (click && click.action.kind === "click"
        ? `Click: ${click.action.target}`
        : hostPath(shot.url));

    const finding =
      typeof meta.finding === "string" ? meta.finding : undefined;

    const highlight =
      meta.highlight && typeof meta.highlight === "object"
        ? (meta.highlight as HighlightBox)
        : DEFAULT_HIGHLIGHT;

    const tone =
      typeof meta.tone === "string" ? meta.tone : TONES[index % TONES.length]!;

    const dataUrl =
      typeof meta.dataUrl === "string" && meta.dataUrl.startsWith("data:")
        ? meta.dataUrl
        : undefined;

    return {
      id: shot.id,
      title,
      timestamp: formatProvenanceTime(shot.t),
      source: hostPath(shot.url),
      url: shot.url || "",
      extractedText,
      tone,
      highlight,
      finding,
      dataUrl,
      provenanceIds: nearby.map((e) => e.id),
    };
  });
}

export function timelineFromProvenance(log: ProvenanceLog): ProvenanceEntry[] {
  return [...log.all()];
}

/** One row in the Open Investigation event log (full provenance, not just shots). */
export type EventLogItem = {
  id: string;
  t: number;
  timestamp: string;
  kind: "status" | "navigate" | "click" | "extract" | "screenshot" | "plan";
  /** Bracket tag shown in the log row, e.g. Navigation. */
  tag: string;
  label: string;
  summary: string;
  url: string;
  /** Matching evidence card id when this event is (or links to) a screenshot. */
  evidenceId?: string;
  detail?: string;
  /**
   * JSON payload shown when the row expands.
   * Screenshot dataUrls are replaced with a short marker so the UI stays light.
   */
  payload: Record<string, unknown>;
};

/** Strip bulky screenshot bytes from provenance for the expandable JSON view. */
export function payloadFromProvenanceEntry(
  entry: ProvenanceEntry,
): Record<string, unknown> {
  const meta = entry.meta ? { ...entry.meta } : undefined;
  if (meta && typeof meta.dataUrl === "string") {
    const dataUrl = meta.dataUrl;
    meta.dataUrl = dataUrl.startsWith("data:")
      ? `[dataUrl omitted · ${Math.round(dataUrl.length / 1024)} KB]`
      : dataUrl;
  }
  return {
    id: entry.id,
    t: entry.t,
    url: entry.url,
    action: entry.action,
    ...(entry.screenshotId ? { screenshotId: entry.screenshotId } : {}),
    ...(meta ? { meta } : {}),
  };
}

function hostOnly(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] || url;
  }
}

/**
 * Project every provenance entry into a readable event-log row.
 * Status / plan / navigate / extract / screenshot all appear in order.
 */
export function eventLogFromProvenance(log: ProvenanceLog): EventLogItem[] {
  const entries = log.all();
  const shotIds = new Set(
    entries.filter((e) => e.action.kind === "screenshot").map((e) => e.id),
  );

  return entries.map((entry) => {
    const meta = entry.meta ?? {};
    const metaKind = typeof meta.kind === "string" ? meta.kind : "";
    const metaLabel = typeof meta.label === "string" ? meta.label : "";
    const action = entry.action;

    let kind: EventLogItem["kind"] = "status";
    let label = metaLabel || action.kind;
    let summary = "";
    let detail: string | undefined;

    if (metaKind === "status" || metaLabel === "Status") {
      kind = "status";
      label = "Status";
      summary =
        action.kind === "extract"
          ? action.text
          : typeof meta.finding === "string"
            ? meta.finding
            : "";
    } else if (metaKind === "plan" || metaLabel === "Research plan") {
      kind = "plan";
      label = "Research plan";
      summary =
        typeof meta.finding === "string"
          ? meta.finding
          : action.kind === "extract"
            ? action.text.split("\n").find((l) => l.trim()) || "Plan"
            : "Plan";
      detail = action.kind === "extract" ? action.text : undefined;
    } else if (action.kind === "navigate") {
      kind = "navigate";
      label = metaLabel || "Navigate";
      summary = action.url || entry.url;
    } else if (action.kind === "click") {
      kind = "click";
      label = "Click";
      summary = action.target;
    } else if (action.kind === "extract") {
      kind = "extract";
      label = metaLabel || "Extract";
      summary =
        (typeof meta.quote === "string" && meta.quote) ||
        (typeof meta.finding === "string" && meta.finding) ||
        action.text.slice(0, 220);
      detail = action.text;
    } else if (action.kind === "screenshot") {
      kind = "screenshot";
      label = action.label || metaLabel || "Capture";
      summary =
        (typeof meta.finding === "string" && meta.finding) ||
        (typeof meta.extractedPreview === "string" && meta.extractedPreview) ||
        hostPath(entry.url);
    } else {
      summary = metaLabel || entry.url;
    }

    const evidenceId =
      kind === "screenshot" && shotIds.has(entry.id)
        ? entry.id
        : undefined;

    const tag =
      kind === "navigate"
        ? "Navigation"
        : kind === "screenshot"
          ? "Capture"
          : kind === "extract"
            ? "Extract"
            : kind === "click"
              ? "Click"
              : kind === "plan"
                ? "Plan"
                : "Status";

    return {
      id: entry.id,
      t: entry.t,
      timestamp: formatProvenanceTime(entry.t),
      kind,
      tag,
      label,
      summary: summary || hostOnly(entry.url) || "—",
      url: entry.url || "",
      evidenceId,
      detail,
      payload: payloadFromProvenanceEntry(entry),
    };
  });
}
