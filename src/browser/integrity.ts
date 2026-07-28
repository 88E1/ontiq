/**
 * Investigation integrity: SHA-256 artifact hashing, hash-chained events,
 * and a root manifest so a case can be handed off with tamper evidence.
 */

export type IntegrityActor = "agent" | "human";

export type ArtifactKind =
  | "html"
  | "pdf"
  | "screenshot"
  | "extract"
  | "event"
  | "status"
  | "other";

export type IntegrityArtifact = {
  id: string;
  kind: ArtifactKind;
  /** SHA-256 hex of the raw bytes / UTF-8 text. */
  sha256: string;
  timestampUtc: string;
  url: string;
  mimeType: string;
  byteSize: number;
  browserSessionId: string;
  investigationId: string;
  runId: string;
  actor: IntegrityActor;
  label?: string;
  /** Optional short preview (never the full raw bytes). */
  preview?: string;
};

export type IntegrityChainEvent = {
  index: number;
  eventId: string;
  /** SHA-256 of the canonical event payload (not including prev/chain). */
  contentHash: string;
  prevHash: string;
  /** SHA-256(prevHash + "\\n" + contentHash). */
  chainHash: string;
  timestampUtc: string;
  actor: IntegrityActor;
  kind: string;
  summary: string;
  url?: string;
  /** Linked artifact id when this event seals an artifact. */
  artifactId?: string;
};

export type InvestigationIntegrity = {
  version: 1;
  algorithm: "sha-256";
  genesis: string;
  investigationId: string;
  runId: string;
  browserSessionId: string;
  title: string;
  startedAtUtc: string;
  endedAtUtc: string;
  durationMs: number;
  userAgent: string;
  viewerUrl?: string | null;
  proxyEnabled: boolean;
  autoCaptcha: boolean;
  cost?: number | null;
  actorPeriods: Array<{
    actor: IntegrityActor;
    startedAtUtc: string;
    endedAtUtc?: string;
  }>;
  artifacts: IntegrityArtifact[];
  chain: IntegrityChainEvent[];
  /** Tip of the event hash chain. */
  chainTip: string;
  /**
   * Root hash over sorted artifact sha256 values + chain tip.
   * Proves the sealed set of evidence for handoff.
   */
  rootHash: string;
};

export const INTEGRITY_GENESIS =
  "sha256:handy-investigation-integrity-v1-genesis";

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(
  data: string | ArrayBuffer | Uint8Array,
): Promise<string> {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

export async function chainHash(
  prevHash: string,
  contentHash: string,
): Promise<string> {
  return sha256Hex(`${prevHash}\n${contentHash}`);
}

export async function computeRootHash(
  artifacts: IntegrityArtifact[],
  chainTip: string,
): Promise<string> {
  const artifactHashes = artifacts
    .map((a) => a.sha256)
    .filter(Boolean)
    .sort();
  return sha256Hex(`${artifactHashes.join("\n")}\n${chainTip}`);
}

export type IntegrityVerifyResult = {
  ok: boolean;
  checkedArtifacts: number;
  checkedChain: number;
  errors: string[];
  recomputedRootHash?: string;
};

/**
 * Recompute chain links and root hash. Does not re-hash raw artifact bytes
 * (those are sealed at capture time); verifies the chain + root binding.
 */
export async function verifyIntegrity(
  pkg: InvestigationIntegrity | null | undefined,
): Promise<IntegrityVerifyResult> {
  if (!pkg || pkg.version !== 1) {
    return {
      ok: false,
      checkedArtifacts: 0,
      checkedChain: 0,
      errors: ["Missing or unsupported integrity package"],
    };
  }
  const errors: string[] = [];
  let prev = pkg.genesis || INTEGRITY_GENESIS;
  if (pkg.genesis !== INTEGRITY_GENESIS) {
    errors.push("Unexpected genesis constant");
  }

  for (const link of pkg.chain) {
    if (link.prevHash !== prev) {
      errors.push(
        `Chain break at #${link.index} (${link.eventId}): prevHash mismatch`,
      );
    }
    const expected = await chainHash(link.prevHash, link.contentHash);
    if (expected !== link.chainHash) {
      errors.push(
        `Chain break at #${link.index} (${link.eventId}): chainHash mismatch`,
      );
    }
    prev = link.chainHash;
  }

  const tip = pkg.chain.length
    ? pkg.chain[pkg.chain.length - 1]!.chainHash
    : pkg.genesis;
  if (pkg.chainTip !== tip) {
    errors.push("chainTip does not match final chain hash");
  }

  const root = await computeRootHash(pkg.artifacts, tip);
  if (pkg.rootHash !== root) {
    errors.push("rootHash does not match sealed artifacts + chain tip");
  }

  return {
    ok: errors.length === 0,
    checkedArtifacts: pkg.artifacts.length,
    checkedChain: pkg.chain.length,
    errors,
    recomputedRootHash: root,
  };
}

export function parseIntegrityJson(
  json: string | null | undefined,
): InvestigationIntegrity | null {
  if (!json || !json.trim()) return null;
  try {
    const parsed = JSON.parse(json) as InvestigationIntegrity;
    if (!parsed || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${s}s`;
}

export function shortHash(hash: string, head = 10, tail = 6): string {
  if (!hash || hash.length <= head + tail + 1) return hash || "—";
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}
