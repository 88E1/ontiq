import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import {
  DEFAULT_INVESTIGATION_TITLE,
  ensureInvestigationSession,
  entriesFromSession,
  eventLogFromSession,
  evidenceFromSession,
  formatDuration,
  integrityFromSession,
  loadInvestigationSession,
  shortHash,
  subscribeInvestigationUpdates,
  verifyIntegrity,
  type EventLogItem,
  type EvidenceItem,
  type IntegrityVerifyResult,
  type InvestigationIntegrity,
  type ProvenanceEntry,
} from "@/browser";
import { type WorkbenchNav } from "./mockData";
import { saveInvestigationZip } from "./exportZip";
import { syncLanguageFromSettings } from "@/i18n";
import { syncThemeFromSettings } from "@/lib/utils/theme";
import { useHandyLock } from "@/hooks/useHandyLock";
import "./InvestigationWorkbench.css";

const NAV_ITEMS: WorkbenchNav[] = [
  "overview",
  "details",
  "findings",
  "evidence",
  "timeline",
  "replay",
];

const InvestigationWorkbench: React.FC = () => {
  const { t } = useTranslation();
  useHandyLock();
  const [nav, setNav] = useState<WorkbenchNav>("evidence");
  const [title, setTitle] = useState(DEFAULT_INVESTIGATION_TITLE);
  const [sessionId, setSessionId] = useState("");
  const [createdAtMs, setCreatedAtMs] = useState(0);
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [eventLog, setEventLog] = useState<EventLogItem[]>([]);
  const [integrity, setIntegrity] = useState<InvestigationIntegrity | null>(
    null,
  );
  const [entries, setEntries] = useState<ProvenanceEntry[]>([]);
  const [integrityJson, setIntegrityJson] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [selectedEventId, setSelectedEventId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [exporting, setExporting] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void syncLanguageFromSettings();
    void syncThemeFromSettings();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;

    const applySession = (
      session: Awaited<ReturnType<typeof loadInvestigationSession>>,
    ) => {
      if (cancelled) return;
      setLoaded(true);
      if (!session) {
        setEvidence([]);
        setEventLog([]);
        setIntegrity(null);
        setEntries([]);
        setIntegrityJson("");
        setSelectedId("");
        setSelectedEventId("");
        setSessionId("");
        setCreatedAtMs(0);
        setTitle(DEFAULT_INVESTIGATION_TITLE);
        return;
      }
      setTitle(session.title || DEFAULT_INVESTIGATION_TITLE);
      setSessionId(session.id);
      setCreatedAtMs(session.created_at_ms);
      const next = evidenceFromSession(session);
      const events = eventLogFromSession(session);
      setEvidence(next);
      setEventLog(events);
      setIntegrity(integrityFromSession(session));
      setEntries(entriesFromSession(session));
      setIntegrityJson(session.integrity_json || "");
      setSelectedId((prev) =>
        next.some((e) => e.id === prev) ? prev : (next[0]?.id ?? ""),
      );
      setSelectedEventId((prev) =>
        events.some((e) => e.id === prev) ? prev : (events[0]?.id ?? ""),
      );
    };

    void (async () => {
      const session = await ensureInvestigationSession();
      applySession(session);
      unsub = await subscribeInvestigationUpdates(applySession);
    })();

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  const selected = useMemo(
    () => evidence.find((e) => e.id === selectedId) ?? evidence[0],
    [evidence, selectedId],
  );

  const captureCount = useMemo(
    () => evidence.filter((e) => e.dataUrl).length,
    [evidence],
  );

  const selectEvidence = (id: string, jumpNav?: WorkbenchNav) => {
    setSelectedId(id);
    const linked = eventLog.find((e) => e.evidenceId === id || e.id === id);
    if (linked) setSelectedEventId(linked.id);
    if (jumpNav) setNav(jumpNav);
  };

  const selectEvent = (event: EventLogItem) => {
    setSelectedEventId(event.id);
    if (event.evidenceId) {
      setSelectedId(event.evidenceId);
    }
  };

  useEffect(() => {
    if (nav !== "timeline") return;
    const el = timelineRef.current?.querySelector(
      `[data-event-id="${selectedEventId}"]`,
    );
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [nav, selectedEventId]);

  const hasSession =
    evidence.length > 0 || eventLog.length > 0 || Boolean(integrity);

  const exportSession = () => {
    if (exporting || !hasSession) return;
    setExporting(true);
    void (async () => {
      try {
        await saveInvestigationZip({
          sessionId,
          title,
          createdAtMs,
          evidence,
          eventLog,
          integrity,
          entries,
          integrityJson,
        });
      } catch (err) {
        console.error("Investigation export failed", err);
        window.alert(
          t("investigation.exportFailed", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      } finally {
        setExporting(false);
      }
    })();
  };

  return (
    <div className="iw">
      <header className="iw-top">
        <div className="iw-top-left">
          <span className="iw-kicker">{t("investigation.kicker")}</span>
          <h1 className="iw-title">{title}</h1>
          {hasSession && (
            <span className="iw-top-meta">
              {t("investigation.captureSummary", {
                captures: captureCount,
                total: evidence.length,
                events: eventLog.length,
              })}
            </span>
          )}
        </div>
        <div className="iw-actions">
          <button
            type="button"
            className="iw-btn"
            onClick={() => {
              void commands.toggleTranscription();
            }}
          >
            {t("investigation.continue")}
          </button>
          <button
            type="button"
            className="iw-btn"
            disabled={evidence.length === 0}
            onClick={() => setNav("replay")}
          >
            {t("investigation.replay")}
          </button>
          <button
            type="button"
            className="iw-btn iw-btn-primary"
            disabled={!hasSession || exporting}
            onClick={exportSession}
          >
            {exporting
              ? t("investigation.exporting")
              : t("investigation.export")}
          </button>
        </div>
      </header>

      <div
        className={`iw-body ${
          nav === "timeline" || nav === "details" ? "iw-body-logs" : ""
        }`}
      >
        <aside className="iw-side" aria-label={t("investigation.navLabel")}>
          {NAV_ITEMS.map((item) => (
            <button
              key={item}
              type="button"
              className={`iw-nav ${nav === item ? "active" : ""}`}
              onClick={() => setNav(item)}
            >
              {t(`investigation.nav.${item}`)}
            </button>
          ))}
        </aside>

        <main className="iw-canvas" aria-label={t("investigation.canvasLabel")}>
          {!loaded ? (
            <div className="iw-panel">
              <p className="iw-panel-copy">{t("investigation.loading")}</p>
            </div>
          ) : !hasSession ? (
            <div className="iw-panel iw-empty">
              <h2 className="iw-panel-title">{t("investigation.emptyTitle")}</h2>
              <p className="iw-panel-copy">{t("investigation.emptyBody")}</p>
            </div>
          ) : (
            <>
              {nav === "details" && (
                <DetailsCanvas integrity={integrity} sessionId={sessionId} />
              )}
              {nav === "overview" && selected && (
                <OverviewCanvas
                  evidence={evidence}
                  selected={selected}
                  captureCount={captureCount}
                  eventCount={eventLog.length}
                  createdAtMs={createdAtMs}
                  onSelect={(id) => selectEvidence(id, "evidence")}
                />
              )}
              {nav === "overview" && !selected && (
                <div className="iw-panel">
                  <h2 className="iw-panel-title">
                    {t("investigation.overviewTitle")}
                  </h2>
                  <p className="iw-panel-copy">
                    {t("investigation.eventLogBody")}
                  </p>
                  <div className="iw-stat-row">
                    <div className="iw-stat">
                      <span className="iw-stat-n">{eventLog.length}</span>
                      <span className="iw-stat-l">
                        {t("investigation.statEvents")}
                      </span>
                    </div>
                  </div>
                </div>
              )}
              {nav === "findings" && (
                <FindingsCanvas
                  evidence={evidence}
                  selectedId={selectedId}
                  onSelect={(id) => selectEvidence(id, "evidence")}
                />
              )}
              {nav === "evidence" && selected && (
                <EvidenceCanvas
                  evidence={evidence}
                  selected={selected}
                  selectedId={selectedId}
                  onSelect={(id) => selectEvidence(id)}
                />
              )}
              {nav === "evidence" && !selected && (
                <div className="iw-panel">
                  <h2 className="iw-panel-title">
                    {t("investigation.evidenceTitle")}
                  </h2>
                  <p className="iw-panel-copy">{t("investigation.noEvents")}</p>
                </div>
              )}
              {nav === "timeline" && (
                <EventLogCanvas
                  ref={timelineRef}
                  events={eventLog}
                  selectedEventId={selectedEventId}
                  onSelect={selectEvent}
                />
              )}
              {nav === "replay" && evidence.length > 0 && (
                <ReplayCanvas
                  evidence={evidence}
                  selectedId={selectedId}
                  onSelect={(id) => selectEvidence(id)}
                />
              )}
              {nav === "replay" && evidence.length === 0 && (
                <div className="iw-panel iw-empty">
                  <h2 className="iw-panel-title">
                    {t("investigation.emptyTitle")}
                  </h2>
                  <p className="iw-panel-copy">{t("investigation.emptyBody")}</p>
                </div>
              )}
            </>
          )}
        </main>

        {nav !== "timeline" && nav !== "details" ? (
          <aside className="iw-detail" aria-label={t("investigation.detailLabel")}>
            {selected ? <DetailPanel selected={selected} /> : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
};

function OverviewCanvas({
  evidence,
  selected,
  captureCount,
  eventCount,
  createdAtMs,
  onSelect,
}: {
  evidence: EvidenceItem[];
  selected: EvidenceItem;
  captureCount: number;
  eventCount: number;
  createdAtMs: number;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const when = createdAtMs
    ? new Date(createdAtMs).toLocaleString()
    : selected.timestamp;

  return (
    <div className="iw-panel">
      <h2 className="iw-panel-title">{t("investigation.overviewTitle")}</h2>
      <p className="iw-panel-copy">{t("investigation.overviewBody")}</p>
      <div className="iw-stat-row">
        <div className="iw-stat">
          <span className="iw-stat-n">{eventCount}</span>
          <span className="iw-stat-l">{t("investigation.statEvents")}</span>
        </div>
        <div className="iw-stat">
          <span className="iw-stat-n">{evidence.length}</span>
          <span className="iw-stat-l">{t("investigation.statEvidence")}</span>
        </div>
        <div className="iw-stat">
          <span className="iw-stat-n">{captureCount}</span>
          <span className="iw-stat-l">{t("investigation.statCaptures")}</span>
        </div>
        <div className="iw-stat">
          <span className="iw-stat-n">
            {evidence.filter((e) => e.finding).length}
          </span>
          <span className="iw-stat-l">{t("investigation.statFindings")}</span>
        </div>
        <div className="iw-stat">
          <span className="iw-stat-n iw-stat-n-sm">{when}</span>
          <span className="iw-stat-l">{t("investigation.statRun")}</span>
        </div>
      </div>

      <div className="iw-focus">
        <EvidenceShot item={selected} large />
        <div className="iw-focus-meta">
          <span className="iw-evidence-time">{selected.timestamp}</span>
          <strong>{selected.title}</strong>
          <span className="iw-focus-url">{selected.source}</span>
          {selected.finding ? (
            <p className="iw-focus-finding">{selected.finding}</p>
          ) : null}
        </div>
      </div>

      <div className="iw-shot-strip">
        {evidence.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`iw-shot ${item.id === selected.id ? "active" : ""}`}
            onClick={() => onSelect(item.id)}
          >
            <EvidenceShot item={item} compact />
            <span>{item.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function FindingsCanvas({
  evidence,
  selectedId,
  onSelect,
}: {
  evidence: EvidenceItem[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const findings = evidence.filter((e) => e.finding);

  return (
    <div className="iw-panel">
      <h2 className="iw-panel-title">{t("investigation.findingsTitle")}</h2>
      {findings.length === 0 ? (
        <p className="iw-panel-copy">{t("investigation.noFindings")}</p>
      ) : (
        <ul className="iw-findings">
          {findings.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`iw-finding ${item.id === selectedId ? "active" : ""}`}
                onClick={() => onSelect(item.id)}
              >
                <EvidenceShot item={item} compact />
                <span className="iw-finding-body">
                  <span className="iw-finding-time">{item.timestamp}</span>
                  <span className="iw-finding-text">{item.finding}</span>
                  <span className="iw-finding-source">{item.source}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EvidenceCanvas({
  evidence,
  selected,
  selectedId,
  onSelect,
}: {
  evidence: EvidenceItem[];
  selected: EvidenceItem;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="iw-panel">
      <h2 className="iw-panel-title">{t("investigation.evidenceTitle")}</h2>

      <div className="iw-hero-shot">
        <div className="iw-browser">
          <div className="iw-browser-bar">
            <span className="iw-browser-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="iw-browser-url">{selected.url || selected.source}</span>
            <span className="iw-browser-time">{selected.timestamp}</span>
          </div>
          <div className="iw-browser-page">
            <EvidenceShot item={selected} large />
          </div>
        </div>
      </div>

      <div className="iw-evidence-grid">
        {evidence.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`iw-evidence-card ${item.id === selectedId ? "active" : ""}`}
            onClick={() => onSelect(item.id)}
          >
            <EvidenceShot item={item} />
            <div className="iw-evidence-meta">
              <span className="iw-evidence-time">{item.timestamp}</span>
              <span className="iw-evidence-title">{item.title}</span>
              <span className="iw-evidence-source">{item.source}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function DetailsCanvas({
  integrity,
  sessionId,
}: {
  integrity: InvestigationIntegrity | null;
  sessionId: string;
}) {
  const { t } = useTranslation();
  const [verify, setVerify] = useState<IntegrityVerifyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copyValue = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => {
        setCopied((k) => (k === key ? null : k));
      }, 1400);
    } catch {
      /* ignore */
    }
  };

  const runVerify = () => {
    setBusy(true);
    void verifyIntegrity(integrity)
      .then(setVerify)
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    if (!integrity) {
      setVerify(null);
      return;
    }
    void verifyIntegrity(integrity).then(setVerify);
  }, [integrity]);

  if (!integrity) {
    return (
      <div className="iw-panel iw-details">
        <h2 className="iw-panel-title">{t("investigation.detailsTitle")}</h2>
        <p className="iw-panel-copy">{t("investigation.detailsMissing")}</p>
      </div>
    );
  }

  const controlLog = (
    integrity as InvestigationIntegrity & {
      controlLog?: Array<{ actor: string; atUtc: string }>;
    }
  ).controlLog;

  const rows: Array<{ key: string; label: string; value: string; mono?: boolean }> =
    [
      {
        key: "id",
        label: t("investigation.meta.id"),
        value: integrity.investigationId || sessionId,
        mono: true,
      },
      {
        key: "run",
        label: t("investigation.meta.runId"),
        value: integrity.runId,
        mono: true,
      },
      {
        key: "browser",
        label: t("investigation.meta.browserSessionId"),
        value: integrity.browserSessionId || "—",
        mono: true,
      },
      {
        key: "started",
        label: t("investigation.meta.timestamp"),
        value: integrity.startedAtUtc,
        mono: true,
      },
      {
        key: "ended",
        label: t("investigation.meta.endedAt"),
        value: integrity.endedAtUtc,
        mono: true,
      },
      {
        key: "duration",
        label: t("investigation.meta.duration"),
        value: formatDuration(integrity.durationMs),
      },
      {
        key: "ua",
        label: t("investigation.meta.userAgent"),
        value: integrity.userAgent || "—",
        mono: true,
      },
      {
        key: "captcha",
        label: t("investigation.meta.autoCaptcha"),
        value: integrity.autoCaptcha ? "true" : "false",
      },
      {
        key: "proxy",
        label: t("investigation.meta.proxyEnabled"),
        value: integrity.proxyEnabled
          ? t("investigation.meta.yes")
          : t("investigation.meta.no"),
      },
      {
        key: "cost",
        label: t("investigation.meta.cost"),
        value:
          integrity.cost == null ? "—" : String(integrity.cost),
      },
      {
        key: "algo",
        label: t("investigation.meta.algorithm"),
        value: integrity.algorithm,
      },
      {
        key: "artifacts",
        label: t("investigation.meta.artifactCount"),
        value: String(integrity.artifacts.length),
      },
      {
        key: "chain",
        label: t("investigation.meta.chainLength"),
        value: String(integrity.chain.length),
      },
      {
        key: "tip",
        label: t("investigation.meta.chainTip"),
        value: integrity.chainTip,
        mono: true,
      },
      {
        key: "root",
        label: t("investigation.meta.rootHash"),
        value: integrity.rootHash,
        mono: true,
      },
    ];

  return (
    <div className="iw-panel iw-details">
      <div className="iw-details-head">
        <h2 className="iw-panel-title">{t("investigation.detailsTitle")}</h2>
        <button
          type="button"
          className="iw-btn"
          disabled={busy}
          onClick={runVerify}
        >
          {busy
            ? t("investigation.verifying")
            : t("investigation.verifyIntegrity")}
        </button>
      </div>
      {verify ? (
        <p
          className={`iw-verify ${verify.ok ? "ok" : "bad"}`}
          role="status"
        >
          {verify.ok
            ? t("investigation.verifyOk", {
                artifacts: verify.checkedArtifacts,
                events: verify.checkedChain,
              })
            : t("investigation.verifyBad", {
                count: verify.errors.length,
              })}
          {!verify.ok && verify.errors[0]
            ? ` · ${verify.errors[0]}`
            : ""}
        </p>
      ) : null}

      <dl className="iw-meta-table">
        {rows.map((row) => (
          <div key={row.key} className="iw-meta-row">
            <dt>{row.label}</dt>
            <dd className={row.mono ? "mono" : undefined}>
              <span title={row.value}>{row.value}</span>
              {row.mono && row.value !== "—" ? (
                <button
                  type="button"
                  className="iw-meta-copy"
                  aria-label={t("investigation.copyJson")}
                  onClick={() => {
                    void copyValue(row.key, row.value);
                  }}
                >
                  {copied === row.key ? "✓" : "⧉"}
                </button>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>

      <h3 className="iw-detail-sub">{t("investigation.actorPeriods")}</h3>
      <ul className="iw-actor-list">
        {integrity.actorPeriods.map((period, i) => (
          <li key={`${period.actor}-${period.startedAtUtc}-${i}`}>
            <strong>{period.actor}</strong>
            <span>
              {period.startedAtUtc}
              {period.endedAtUtc ? ` → ${period.endedAtUtc}` : ""}
            </span>
          </li>
        ))}
        {(controlLog || []).map((c, i) => (
          <li key={`ctrl-${c.atUtc}-${i}`}>
            <strong>{c.actor}</strong>
            <span>
              {c.atUtc} · {t("investigation.takeControlNote")}
            </span>
          </li>
        ))}
      </ul>

      <h3 className="iw-detail-sub">{t("investigation.sealedArtifacts")}</h3>
      <ul className="iw-artifact-list">
        {integrity.artifacts.map((art) => (
          <li key={art.id}>
            <div className="iw-artifact-top">
              <span className={`iw-log-tag kind-${art.kind}`}>
                [{art.kind}]
              </span>
              <span className="iw-artifact-label">
                {art.label || art.kind}
              </span>
              <span className="iw-artifact-size">
                {art.byteSize.toLocaleString()} B
              </span>
            </div>
            <div className="iw-artifact-meta mono">
              {art.timestampUtc} · {art.mimeType} · {art.actor}
            </div>
            {art.url ? (
              <div className="iw-artifact-url" title={art.url}>
                {art.url}
              </div>
            ) : null}
            <div className="iw-artifact-hash mono" title={art.sha256}>
              sha256:{shortHash(art.sha256, 16, 10)}
              <button
                type="button"
                className="iw-meta-copy"
                onClick={() => {
                  void copyValue(art.id, art.sha256);
                }}
              >
                {copied === art.id ? "✓" : "⧉"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const EventLogCanvas = React.forwardRef<
  HTMLDivElement,
  {
    events: EventLogItem[];
    selectedEventId: string;
    onSelect: (event: EventLogItem) => void;
  }
>(function EventLogCanvas({ events, selectedEventId, onSelect }, ref) {
  const { t } = useTranslation();
  const [expandedId, setExpandedId] = useState<string | null>(
    selectedEventId || null,
  );
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedEventId) setExpandedId(selectedEventId);
  }, [selectedEventId]);

  const toggleEvent = (event: EventLogItem) => {
    onSelect(event);
    setExpandedId((prev) => (prev === event.id ? null : event.id));
  };

  const copyJson = async (event: EventLogItem) => {
    const text = JSON.stringify(event.payload, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(event.id);
      window.setTimeout(() => {
        setCopiedId((id) => (id === event.id ? null : id));
      }, 1600);
    } catch {
      /* clipboard may be denied */
    }
  };

  return (
    <div className="iw-panel iw-eventlog" ref={ref}>
      <h2 className="iw-panel-title">{t("investigation.timelineTitle")}</h2>
      {events.length === 0 ? (
        <p className="iw-panel-copy">{t("investigation.noEvents")}</p>
      ) : (
        <ol className="iw-log-list">
          {events.map((event) => {
            const open = expandedId === event.id;
            const json = JSON.stringify(event.payload, null, 2);
            return (
              <li
                key={event.id}
                data-event-id={event.id}
                className={`iw-log-row kind-${event.kind} ${open ? "open" : ""}`}
              >
                <button
                  type="button"
                  className="iw-log-head"
                  aria-expanded={open}
                  onClick={() => toggleEvent(event)}
                >
                  <span className="iw-log-time">{event.timestamp}</span>
                  <span className={`iw-log-tag kind-${event.kind}`}>
                    [{event.tag}]
                  </span>
                  <span className="iw-log-msg" title={event.summary}>
                    {event.summary}
                  </span>
                  <span className="iw-log-chevron" aria-hidden="true">
                    <svg viewBox="0 0 12 12" width="12" height="12" fill="none">
                      <path
                        d={open ? "M3 8 L6 4 L9 8" : "M3 4 L6 8 L9 4"}
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                </button>
                {open ? (
                  <div className="iw-log-body">
                    <pre className="iw-log-json">{json}</pre>
                    <button
                      type="button"
                      className="iw-log-copy"
                      onClick={() => {
                        void copyJson(event);
                      }}
                    >
                      <svg
                        viewBox="0 0 16 16"
                        width="14"
                        height="14"
                        fill="none"
                        aria-hidden="true"
                      >
                        <rect
                          x="5.5"
                          y="5.5"
                          width="7"
                          height="8"
                          rx="1.2"
                          stroke="currentColor"
                          strokeWidth="1.3"
                        />
                        <path
                          d="M3.5 10.5 V3.8 A1.3 1.3 0 0 1 4.8 2.5 H10.5"
                          stroke="currentColor"
                          strokeWidth="1.3"
                          strokeLinecap="round"
                        />
                      </svg>
                      {copiedId === event.id
                        ? t("investigation.copyJsonDone")
                        : t("investigation.copyJson")}
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
});

function ReplayCanvas({
  evidence,
  selectedId,
  onSelect,
}: {
  evidence: EvidenceItem[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(true);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const index = Math.max(
    0,
    evidence.findIndex((e) => e.id === selectedId),
  );
  const selected = evidence[index] ?? evidence[0];

  useEffect(() => {
    if (!playing || evidence.length < 2) return;
    const id = window.setInterval(() => {
      const current = Math.max(
        0,
        evidence.findIndex((e) => e.id === selectedId),
      );
      const next = (current + 1) % evidence.length;
      onSelectRef.current(evidence[next]!.id);
    }, 1600);
    return () => window.clearInterval(id);
  }, [playing, evidence, selectedId]);

  if (!selected) return null;

  return (
    <div className="iw-panel iw-replay">
      <div className="iw-replay-head">
        <h2 className="iw-panel-title">{t("investigation.replayTitle")}</h2>
        <div className="iw-replay-controls">
          <button
            type="button"
            className="iw-btn"
            onClick={() => setPlaying((p) => !p)}
          >
            {playing
              ? t("investigation.replayPause")
              : t("investigation.replayPlay")}
          </button>
          <span className="iw-replay-pos">
            {t("investigation.replayPosition", {
              current: index + 1,
              total: evidence.length,
            })}
          </span>
        </div>
      </div>
      <div className="iw-browser">
        <div className="iw-browser-bar">
          <span className="iw-browser-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="iw-browser-url">{selected.url || selected.source}</span>
          <span className="iw-browser-time">{selected.timestamp}</span>
        </div>
        <div className="iw-browser-page">
          <EvidenceShot item={selected} large />
        </div>
      </div>
      <div className="iw-replay-film">
        {evidence.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`iw-replay-frame ${item.id === selected.id ? "active" : ""}`}
            onClick={() => {
              setPlaying(false);
              onSelect(item.id);
            }}
          >
            <EvidenceShot item={item} compact />
          </button>
        ))}
      </div>
    </div>
  );
}

function DetailPanel({ selected }: { selected: EvidenceItem }) {
  const { t } = useTranslation();
  return (
    <>
      <h2 className="iw-detail-title">{t("investigation.details")}</h2>
      <div className="iw-detail-shot">
        <EvidenceShot item={selected} />
      </div>
      <dl className="iw-detail-list">
        <div>
          <dt>{t("investigation.source")}</dt>
          <dd>
            {selected.url ? (
              <a
                className="iw-link"
                href={selected.url}
                target="_blank"
                rel="noreferrer"
              >
                {selected.source}
              </a>
            ) : (
              selected.source
            )}
          </dd>
        </div>
        <div>
          <dt>{t("investigation.timestamp")}</dt>
          <dd>{selected.timestamp}</dd>
        </div>
        <div>
          <dt>{t("investigation.moment")}</dt>
          <dd>{selected.title}</dd>
        </div>
        <div>
          <dt>{t("investigation.capture")}</dt>
          <dd>
            {selected.dataUrl
              ? t("investigation.captureReady")
              : t("investigation.captureMissing")}
          </dd>
        </div>
      </dl>
      {selected.extractedText ? (
        <>
          <h3 className="iw-detail-sub">{t("investigation.extractedText")}</h3>
          <pre className="iw-detail-text">{selected.extractedText}</pre>
        </>
      ) : null}
      {selected.finding ? (
        <>
          <h3 className="iw-detail-sub">{t("investigation.linkedFinding")}</h3>
          <p className="iw-detail-finding">{selected.finding}</p>
        </>
      ) : null}
    </>
  );
}

function EvidenceShot({
  item,
  compact,
  large,
}: {
  item: EvidenceItem;
  compact?: boolean;
  large?: boolean;
}) {
  const { t } = useTranslation();
  const { highlight, tone, dataUrl, title } = item;

  if (dataUrl) {
    return (
      <div
        className={`iw-shot-frame ${compact ? "compact" : ""} ${large ? "large" : ""}`}
      >
        <img src={dataUrl} alt={title} className="iw-shot-img" draggable={false} />
      </div>
    );
  }

  return (
    <div
      className={`iw-shot-frame iw-shot-placeholder ${compact ? "compact" : ""} ${large ? "large" : ""}`}
      style={{ background: tone }}
      aria-hidden="true"
    >
      <span
        className="iw-mock-hl"
        style={{
          left: `${highlight.x}%`,
          top: `${highlight.y}%`,
          width: `${highlight.w}%`,
          height: `${highlight.h}%`,
        }}
      />
      <span className="iw-shot-missing">
        {t("investigation.captureUnavailable")}
      </span>
    </div>
  );
}

export default InvestigationWorkbench;
