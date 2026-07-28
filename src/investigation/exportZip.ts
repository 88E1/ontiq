/**
 * Pack a Handy investigation into a ZIP for case handoff.
 * Includes manifests, integrity, event log, extracts, and screenshot files.
 *
 * Downloads use Tauri's native save dialog + fs write (anchor downloads are
 * a no-op inside the Tauri webview).
 */
import { zipSync, strToU8 } from "fflate";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { EventLogItem, EvidenceItem } from "@/browser";
import type { InvestigationIntegrity } from "@/browser";
import type { ProvenanceEntry } from "@/browser";

export type InvestigationExportInput = {
  sessionId: string;
  title: string;
  createdAtMs: number;
  evidence: EvidenceItem[];
  eventLog: EventLogItem[];
  integrity: InvestigationIntegrity | null;
  /** Raw provenance entries (dataUrls may be present for sealed shots). */
  entries: ProvenanceEntry[];
  /** Raw integrity JSON string when available (preserves controlLog etc.). */
  integrityJson?: string;
};

function safeName(input: string, fallback: string): string {
  const cleaned = input
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function dataUrlToFile(
  dataUrl: string,
): { bytes: Uint8Array; ext: string; mime: string } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  const isB64 = Boolean(m[2]);
  const payload = m[3] || "";
  let bytes: Uint8Array;
  if (isB64) {
    const bin = atob(payload);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = strToU8(decodeURIComponent(payload));
  }
  const ext = mime.includes("jpeg") || mime.includes("jpg")
    ? "jpg"
    : mime.includes("png")
      ? "png"
      : mime.includes("webp")
        ? "webp"
        : mime.includes("gif")
          ? "gif"
          : "bin";
  return { bytes, ext, mime };
}

function slimEntries(entries: ProvenanceEntry[]): unknown[] {
  return entries.map((entry) => {
    const meta = entry.meta ? { ...entry.meta } : undefined;
    if (meta && typeof meta.dataUrl === "string") {
      const dataUrl = meta.dataUrl;
      meta.dataUrl = dataUrl.startsWith("data:")
        ? `[embedded in captures/ · ${Math.round(dataUrl.length / 1024)} KB]`
        : dataUrl;
    }
    return {
      id: entry.id,
      t: entry.t,
      url: entry.url,
      action: entry.action,
      screenshotId: entry.screenshotId,
      meta,
    };
  });
}

function buildReadme(input: InvestigationExportInput, folder: string): string {
  const lines = [
    "Handy Investigation Export",
    "==========================",
    "",
    `Title: ${input.title}`,
    `Investigation ID: ${input.sessionId || "(none)"}`,
    `Created (local): ${
      input.createdAtMs ? new Date(input.createdAtMs).toISOString() : "unknown"
    }`,
    `Exported (UTC): ${new Date().toISOString()}`,
    "",
    "Contents",
    "--------",
    `${folder}/README.txt                 This file`,
    `${folder}/summary.json               Case overview (no raw screenshots)`,
    `${folder}/integrity.json             SHA-256 artifacts + hash chain + root hash`,
    `${folder}/event-log.json             Full event log (expandable JSON source)`,
    `${folder}/event-log.txt              Human-readable event timeline`,
    `${folder}/provenance.json            Provenance actions (screenshots referenced)`,
    `${folder}/findings.md                Findings and extracted text`,
    `${folder}/captures/                  Screenshot images + per-capture metadata`,
    `${folder}/extracts/                  Extracted text snippets as .txt files`,
    "",
    "Integrity",
    "---------",
    input.integrity
      ? [
          `Algorithm: ${input.integrity.algorithm}`,
          `Root hash: ${input.integrity.rootHash}`,
          `Chain tip: ${input.integrity.chainTip}`,
          `Artifacts: ${input.integrity.artifacts.length}`,
          `Chained events: ${input.integrity.chain.length}`,
          "",
          "Verify by recomputing SHA-256 over each artifact file and checking",
          "that integrity.json chain hashes and rootHash still match.",
        ].join("\n")
      : "No integrity manifest was sealed for this run.",
    "",
  ];
  return lines.join("\n");
}

function buildFindingsMd(input: InvestigationExportInput): string {
  const findings = input.evidence.filter((e) => e.finding || e.extractedText);
  const parts = [
    `# ${input.title}`,
    "",
    `Investigation ID: \`${input.sessionId || "unknown"}\``,
    "",
  ];
  if (findings.length === 0) {
    parts.push("_No findings or extracted text were recorded._", "");
    return parts.join("\n");
  }
  findings.forEach((item, i) => {
    parts.push(`## ${i + 1}. ${item.title || item.source || item.id}`);
    parts.push("");
    parts.push(`- Time: ${item.timestamp}`);
    parts.push(`- URL: ${item.url || item.source || "—"}`);
    if (item.finding) {
      parts.push("", "**Finding**", "", item.finding);
    }
    if (item.extractedText) {
      parts.push("", "**Extracted**", "", item.extractedText);
    }
    parts.push("");
  });
  return parts.join("\n");
}

/**
 * Build a ZIP of the investigation case package.
 */
export function buildInvestigationZip(
  input: InvestigationExportInput,
): { bytes: Uint8Array; filename: string } {
  const id = safeName(input.sessionId || "export", "export");
  const folder = `handy-investigation-${id}`;
  const files: Record<string, Uint8Array> = {};

  const put = (rel: string, data: string | Uint8Array) => {
    files[`${folder}/${rel}`] =
      typeof data === "string" ? strToU8(data) : data;
  };

  put("README.txt", buildReadme(input, folder));
  put("findings.md", buildFindingsMd(input));

  const summary = {
    id: input.sessionId,
    title: input.title,
    createdAtMs: input.createdAtMs,
    exportedAtMs: Date.now(),
    exportedAtUtc: new Date().toISOString(),
    counts: {
      evidence: input.evidence.length,
      captures: input.evidence.filter((e) => e.dataUrl).length,
      events: input.eventLog.length,
      artifacts: input.integrity?.artifacts.length ?? 0,
      chainEvents: input.integrity?.chain.length ?? 0,
    },
    integrity: input.integrity
      ? {
          investigationId: input.integrity.investigationId,
          runId: input.integrity.runId,
          browserSessionId: input.integrity.browserSessionId,
          rootHash: input.integrity.rootHash,
          chainTip: input.integrity.chainTip,
          startedAtUtc: input.integrity.startedAtUtc,
          endedAtUtc: input.integrity.endedAtUtc,
          durationMs: input.integrity.durationMs,
          userAgent: input.integrity.userAgent,
        }
      : null,
    captures: input.evidence.map((item, index) => ({
      index: index + 1,
      id: item.id,
      title: item.title,
      timestamp: item.timestamp,
      url: item.url,
      source: item.source,
      finding: item.finding ?? null,
      extractedText: item.extractedText,
      hasScreenshot: Boolean(item.dataUrl),
      file: item.dataUrl
        ? `captures/${pad(index + 1)}-${safeName(item.title, item.id)}.${
            dataUrlToFile(item.dataUrl)?.ext || "bin"
          }`
        : null,
    })),
  };
  put("summary.json", JSON.stringify(summary, null, 2));

  if (input.integrityJson?.trim()) {
    put("integrity.json", input.integrityJson);
  } else if (input.integrity) {
    put("integrity.json", JSON.stringify(input.integrity, null, 2));
  } else {
    put(
      "integrity.json",
      JSON.stringify({ note: "No integrity package for this run." }, null, 2),
    );
  }

  const eventLogJson = input.eventLog.map((item, index) => ({
    index: index + 1,
    id: item.id,
    t: item.t,
    timestamp: item.timestamp,
    kind: item.kind,
    tag: item.tag,
    label: item.label,
    summary: item.summary,
    url: item.url,
    detail: item.detail ?? null,
    payload: item.payload,
  }));
  put("event-log.json", JSON.stringify(eventLogJson, null, 2));
  put(
    "event-log.txt",
    input.eventLog.length === 0
      ? "(no events)\n"
      : input.eventLog
          .map(
            (e) =>
              `${e.timestamp}\t[${e.tag}]\t${e.label}\t${e.summary}${
                e.url && e.url !== "about:blank" ? `\t${e.url}` : ""
              }`,
          )
          .join("\n") + "\n",
  );

  put("provenance.json", JSON.stringify(slimEntries(input.entries), null, 2));

  input.evidence.forEach((item, index) => {
    const n = pad(index + 1);
    const base = `${n}-${safeName(item.title, item.id)}`;
    put(
      `captures/${base}.json`,
      JSON.stringify(
        {
          id: item.id,
          title: item.title,
          timestamp: item.timestamp,
          url: item.url,
          source: item.source,
          finding: item.finding ?? null,
          extractedText: item.extractedText,
          highlight: item.highlight,
          provenanceIds: item.provenanceIds,
        },
        null,
        2,
      ),
    );
    if (item.dataUrl) {
      const file = dataUrlToFile(item.dataUrl);
      if (file) {
        put(`captures/${base}.${file.ext}`, file.bytes);
      }
    }
    if (item.extractedText?.trim() || item.finding?.trim()) {
      const body = [
        item.title,
        item.url || item.source,
        "",
        item.finding ? `Finding:\n${item.finding}\n` : "",
        item.extractedText ? `Extracted:\n${item.extractedText}\n` : "",
      ]
        .filter(Boolean)
        .join("\n");
      put(`extracts/${base}.txt`, body);
    }
  });

  // Also dump integrity artifact metadata list for auditors.
  if (input.integrity?.artifacts?.length) {
    put(
      "artifacts.json",
      JSON.stringify(input.integrity.artifacts, null, 2),
    );
  }

  const zipped = zipSync(files, { level: 6 });

  return {
    bytes: zipped,
    filename: `${folder}.zip`,
  };
}

/**
 * Prompt for a save location and write the ZIP. Returns the path, or null if cancelled.
 */
export async function saveInvestigationZip(
  input: InvestigationExportInput,
): Promise<string | null> {
  const { bytes, filename } = buildInvestigationZip(input);
  const path = await save({
    title: "Export investigation",
    defaultPath: filename,
    filters: [{ name: "ZIP archive", extensions: ["zip"] }],
  });
  if (!path) return null;
  await writeFile(path, bytes);
  return path;
}
