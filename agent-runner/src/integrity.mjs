/**
 * SHA-256 investigation integrity ledger for Handy agent-runner.
 * Seals artifacts + hash-chained events into a handoff manifest.
 */
import crypto from "node:crypto";

export const INTEGRITY_GENESIS =
  "sha256:handy-investigation-integrity-v1-genesis";

export function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function utcNow(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export class IntegrityLedger {
  constructor({
    investigationId,
    runId,
    browserSessionId = "",
    title = "Investigation",
    userAgent = "",
    viewerUrl = null,
  } = {}) {
    this.investigationId = investigationId || newId("inv");
    this.runId = runId || newId("run");
    this.browserSessionId = browserSessionId || "";
    this.title = title;
    this.userAgent = userAgent;
    this.viewerUrl = viewerUrl;
    this.startedAtMs = Date.now();
    this.startedAtUtc = utcNow(this.startedAtMs);
    this.actor = "agent";
    this.actorPeriods = [
      { actor: "agent", startedAtUtc: this.startedAtUtc },
    ];
    this.artifacts = [];
    this.chain = [];
    this.prevHash = INTEGRITY_GENESIS;
    this.proxyEnabled = false;
    this.autoCaptcha = false;
    this.cost = null;
    this._seq = 0;
    /** @type {Map<string, string>} provenance/event id → artifact id */
    this._eventArtifacts = new Map();
  }

  setBrowserSession(sessionId, extras = {}) {
    if (sessionId) this.browserSessionId = sessionId;
    if (extras.viewerUrl !== undefined) this.viewerUrl = extras.viewerUrl;
    if (extras.userAgent) this.userAgent = extras.userAgent;
    if (typeof extras.proxyEnabled === "boolean") {
      this.proxyEnabled = extras.proxyEnabled;
    }
    if (typeof extras.autoCaptcha === "boolean") {
      this.autoCaptcha = extras.autoCaptcha;
    }
    if (extras.cost != null) this.cost = extras.cost;
  }

  setTitle(title) {
    if (title) this.title = title;
  }

  setActor(actor) {
    if (actor !== "human" && actor !== "agent") return;
    if (actor === this.actor) return;
    const now = utcNow();
    const current = this.actorPeriods[this.actorPeriods.length - 1];
    if (current && !current.endedAtUtc) current.endedAtUtc = now;
    this.actorPeriods.push({ actor, startedAtUtc: now });
    this.actor = actor;
    this.addEvent({
      eventId: newId("actor"),
      kind: "actor",
      summary: `Actor → ${actor}`,
      payload: { actor, at: now },
    });
  }

  /**
   * Seal raw bytes (Buffer | Uint8Array | string) as an artifact.
   * Chain linking happens via sealProvenanceEntry / addEvent.
   */
  addArtifact({
    kind,
    mimeType,
    url = "",
    data,
    label,
    preview,
    eventId,
  }) {
    const buf =
      typeof data === "string"
        ? Buffer.from(data, "utf8")
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
    const sha256 = sha256Hex(buf);
    const id = newId(`art_${kind}`);
    const timestampUtc = utcNow();
    const artifact = {
      id,
      kind,
      sha256,
      timestampUtc,
      url: url || "",
      mimeType: mimeType || "application/octet-stream",
      byteSize: buf.length,
      browserSessionId: this.browserSessionId,
      investigationId: this.investigationId,
      runId: this.runId,
      actor: this.actor,
      label: label || kind,
      preview: preview ? String(preview).slice(0, 240) : undefined,
    };
    this.artifacts.push(artifact);
    if (eventId) this._eventArtifacts.set(eventId, id);
    return artifact;
  }

  addTextArtifact(opts) {
    return this.addArtifact({
      ...opts,
      data: opts.text ?? "",
      mimeType: opts.mimeType || "text/plain; charset=utf-8",
    });
  }

  addEvent({ eventId, kind, summary, url = "", artifactId, payload }) {
    this._seq += 1;
    const timestampUtc = utcNow();
    const body = {
      eventId,
      kind,
      summary,
      url,
      artifactId: artifactId || null,
      actor: this.actor,
      timestampUtc,
      investigationId: this.investigationId,
      runId: this.runId,
      browserSessionId: this.browserSessionId,
      payload: payload ?? null,
    };
    const contentHash = sha256Hex(JSON.stringify(body));
    const chainHash = sha256Hex(`${this.prevHash}\n${contentHash}`);
    const link = {
      index: this._seq,
      eventId,
      contentHash,
      prevHash: this.prevHash,
      chainHash,
      timestampUtc,
      actor: this.actor,
      kind,
      summary: String(summary || "").slice(0, 400),
      url: url || undefined,
      artifactId,
    };
    this.chain.push(link);
    this.prevHash = chainHash;
    return link;
  }

  /** Hash a provenance entry (without bulky dataUrl) into the chain. */
  sealProvenanceEntry(entry) {
    const eventId = entry.id || newId("prov");
    const meta = entry?.meta && typeof entry.meta === "object" ? { ...entry.meta } : {};
    if (typeof meta.dataUrl === "string") {
      meta.dataUrl = `[omitted · ${meta.dataUrl.length} chars]`;
    }
    const artifactId = this._eventArtifacts.get(eventId);
    const slim = {
      id: entry.id,
      t: entry.t,
      url: entry.url,
      action: entry.action,
      screenshotId: entry.screenshotId,
      meta,
      artifactSha256: artifactId
        ? this.artifacts.find((a) => a.id === artifactId)?.sha256
        : undefined,
    };
    return this.addEvent({
      eventId,
      kind: `provenance:${entry?.action?.kind || "unknown"}`,
      summary:
        (typeof meta.label === "string" && meta.label) ||
        entry?.action?.kind ||
        "provenance",
      url: entry.url,
      artifactId,
      payload: slim,
    });
  }

  finalize({ title } = {}) {
    if (title) this.title = title;
    const endedAtMs = Date.now();
    const endedAtUtc = utcNow(endedAtMs);
    const lastPeriod = this.actorPeriods[this.actorPeriods.length - 1];
    if (lastPeriod && !lastPeriod.endedAtUtc) lastPeriod.endedAtUtc = endedAtUtc;

    // Seal a snapshot of the event log (pre-seal) as its own artifact + chain link.
    const eventLogText = this.chain
      .map(
        (e) =>
          `${e.timestampUtc}\t[${e.kind}]\t${e.actor}\t${e.summary}\t${e.contentHash}`,
      )
      .join("\n");
    const eventLogId = newId("eventlog");
    const eventArt = this.addTextArtifact({
      kind: "event",
      mimeType: "text/plain; charset=utf-8",
      url: "",
      text: eventLogText,
      label: "Event log",
      preview: `${this.chain.length} chained events`,
      eventId: eventLogId,
    });
    this.addEvent({
      eventId: eventLogId,
      kind: "artifact:event",
      summary: `Event log · ${this.chain.length} events`,
      artifactId: eventArt.id,
      payload: {
        artifactId: eventArt.id,
        sha256: eventArt.sha256,
        byteSize: eventArt.byteSize,
      },
    });

    const chainTip = this.prevHash;
    const artifactHashes = this.artifacts
      .map((a) => a.sha256)
      .filter(Boolean)
      .sort();
    const rootHash = sha256Hex(`${artifactHashes.join("\n")}\n${chainTip}`);

    return {
      version: 1,
      algorithm: "sha-256",
      genesis: INTEGRITY_GENESIS,
      investigationId: this.investigationId,
      runId: this.runId,
      browserSessionId: this.browserSessionId,
      title: this.title,
      startedAtUtc: this.startedAtUtc,
      endedAtUtc,
      durationMs: Math.max(0, endedAtMs - this.startedAtMs),
      userAgent: this.userAgent || "",
      viewerUrl: this.viewerUrl || null,
      proxyEnabled: this.proxyEnabled,
      autoCaptcha: this.autoCaptcha,
      cost: this.cost,
      actorPeriods: this.actorPeriods,
      artifacts: this.artifacts,
      chain: this.chain,
      chainTip,
      rootHash,
    };
  }
}

export function createLedger(opts) {
  return new IntegrityLedger(opts);
}
