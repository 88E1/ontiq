import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./RecordingOverlay.css";
import { commands, events } from "@/bindings";
import {
  clearInvestigationSession,
  ensureInvestigationSession,
  entriesFromSession,
  eventLogFromSession,
  evidenceFromSession,
  integrityFromSession,
  loadInvestigationSession,
} from "@/browser";
import { saveInvestigationZip } from "@/investigation/exportZip";
import type {
  StreamPhase,
  StreamPhaseEvent,
  StreamTextEvent,
  StreamWorkKind,
} from "@/bindings";
import i18n, { syncLanguageFromSettings } from "@/i18n";
import { useOsType } from "@/hooks/useOsType";
import { useHandyLock } from "@/hooks/useHandyLock";
import { formatKeyCombination } from "@/lib/utils/keyboard";
import { getLanguageDirection } from "@/lib/utils/rtl";
import takeControlIcon from "./take-control-icon.png";
import openInvestigationIcon from "./icon-open-investigation.png";
import replayIcon from "./icon-replay.png";
import exportIcon from "./icon-export.png";
import backIcon from "./icon-back.png";

type OverlayState =
  | "recording"
  | "streaming"
  | "transcribing"
  | "processing"
  | "result"
  | "complete";

// Number of reactive bars in the waveform (the simple, smoothed style shared by
// every overlay form). Mic levels arrive as 16 FFT buckets; we take the first N.
const WAVE_BARS = 9;
// Peak mic level (0-1) that counts as “started talking” while prompt hints rotate.
const SPEECH_LEVEL_THRESHOLD = 0.14;
const PROMPT_ROTATE_MS = 2800;
// Ignore mic spikes briefly after Continue so the start chime doesn’t clear prompts.
const SPEECH_DETECT_GRACE_MS = 900;

const RecordingOverlay: React.FC = () => {
  const { t } = useTranslation();
  const osType = useOsType();
  useHandyLock();
  const [isVisible, setIsVisible] = useState(false);
  const [state, setState] = useState<OverlayState>("recording");
  const [levels, setLevels] = useState<number[]>(Array(WAVE_BARS).fill(0));
  const [streamText, setStreamText] = useState<StreamTextEvent>({
    committed: "",
    tentative: "",
  });
  const [phase, setPhase] = useState<StreamPhase>("listening");
  const [workKind, setWorkKind] = useState<StreamWorkKind>("transcribing");
  const [elapsed, setElapsed] = useState(0);
  // Bumped on each new streaming session so the Live card remounts fresh (replays
  // the pop-in, and never animates in from the previous panel's open size).
  const [session, setSession] = useState(0);
  // Overlay placement (top vs bottom of the screen). The Live panel grows downward
  // from a top overlay (oldest line under the pill) and upward from a bottom one.
  const [position, setPosition] = useState<"top" | "bottom">("bottom");
  // True once live text overflows the cap. A top overlay fades its top edge only
  // while overflowing, so the resting first line stays crisp flush under the pill.
  const [overflowing, setOverflowing] = useState(false);
  // Placeholder pause/resume toggle on the post-transcription action pill.
  const [isPaused, setIsPaused] = useState(false);
  // After "Continue" on the completion screen - compact pill rotates sample
  // follow-ups until the mic hears speech, then shows the live waveform.
  const [awaitingNextObjective, setAwaitingNextObjective] = useState(false);
  const [promptIndex, setPromptIndex] = useState(0);
  // Live "transcribe" binding for the Continue button shortcut chips.
  const [transcribeBinding, setTranscribeBinding] = useState("");
  // Shown when the user clicks Start over on the completion screen.
  const [confirmNewInvestigation, setConfirmNewInvestigation] = useState(false);
  // Live isolated-browser frame streamed into the screen-share slot.
  const [shareFrame, setShareFrame] = useState<{
    url: string;
    label: string;
    status: string;
    tone?: string;
    highlight?: { x: number; y: number; w: number; h: number };
    dataUrl?: string;
    quote?: string;
    meaning?: string;
  } | null>(null);
  // Steel debugUrl WebRTC embed (preferred over PNG screenshots while running).
  const [liveViewerUrl, setLiveViewerUrl] = useState<string | null>(null);
  const [liveInteractive, setLiveInteractive] = useState(false);
  const [agentStatus, setAgentStatus] = useState("");
  // Screenshots captured during the live Steel run - replayed as a slideshow
  // on the completion screen.
  const [capturedShots, setCapturedShots] = useState<
    Array<{
      dataUrl: string;
      url: string;
      label: string;
      quote?: string;
      meaning?: string;
    }>
  >([]);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(true);

  const liveViewerUrlRef = useRef<string | null>(null);
  const smoothedLevelsRef = useRef<number[]>(Array(16).fill(0));
  const speechDetectAfterRef = useRef(0);
  // Completion screen is up - a hotkey/Continue should rotate follow-up prompts.
  // Start over sets this so the next recording is a fresh run without prompts.
  const onCompleteScreenRef = useRef(false);
  const skipObjectivePromptsRef = useRef(false);
  // Live-text scroll-back: the text region "sticks" to the newest line while the
  // user is at the bottom; if they scroll up to read history, auto-follow pauses
  // until they scroll back down.
  const capRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const direction = getLanguageDirection(i18n.language);

  useEffect(() => {
    const setupEventListeners = async () => {
      const unlistenShow = await listen("show-overlay", async (event) => {
        await syncLanguageFromSettings();
        // The Live panel flows downward from a top overlay and upward from a
        // bottom one; read the placement so the layout can flip to match.
        try {
          const settings = await commands.getAppSettings();
          if (settings.status === "ok") {
            setPosition(
              settings.data.overlay_position === "top" ? "top" : "bottom",
            );
            const binding =
              settings.data.bindings?.transcribe?.current_binding ?? "";
            setTranscribeBinding(binding);
          }
        } catch {
          // Keep the previous/default placement if settings can't be read.
        }
        const overlayState = event.payload as OverlayState;
        setState(overlayState);
        if (overlayState === "recording" || overlayState === "streaming") {
          setStreamText({ committed: "", tentative: "" });
          setConfirmNewInvestigation(false);
          // Hotkey or Continue from the completion screen → follow-up prompts.
          // Explicit Start over skips prompts for a fresh investigation.
          if (
            overlayState === "recording" &&
            onCompleteScreenRef.current &&
            !skipObjectivePromptsRef.current
          ) {
            setPromptIndex(0);
            speechDetectAfterRef.current =
              Date.now() + SPEECH_DETECT_GRACE_MS;
            setAwaitingNextObjective(true);
          } else if (skipObjectivePromptsRef.current) {
            setAwaitingNextObjective(false);
          }
          onCompleteScreenRef.current = false;
          skipObjectivePromptsRef.current = false;
        }
        if (overlayState === "streaming") {
          // Live panel replaces the rotating-prompt pill.
          setAwaitingNextObjective(false);
          setPhase("listening");
          setWorkKind("transcribing");
          setElapsed(0);
          setSession((s) => s + 1); // remount the card fresh for this session
        }
        if (overlayState === "result") {
          setIsPaused(false);
          setAwaitingNextObjective(false);
          onCompleteScreenRef.current = false;
          setShareFrame(null);
          setLiveViewerUrl(null);
          setLiveInteractive(false);
          setCapturedShots([]);
          setReplayIndex(0);
          setReplayPlaying(true);
          setAgentStatus(t("overlay.agentStarting"));
        }
        if (overlayState === "complete") {
          setAwaitingNextObjective(false);
          setConfirmNewInvestigation(false);
          onCompleteScreenRef.current = true;
          skipObjectivePromptsRef.current = false;
          setLiveViewerUrl(null);
          setLiveInteractive(false);
          setReplayIndex(0);
          setReplayPlaying(true);
          // Hydrate slideshow from the saved session if live capture missed any.
          void (async () => {
            const session = await ensureInvestigationSession();
            if (!session) return;
            try {
              const entries = JSON.parse(session.entries_json) as Array<{
                url?: string;
                meta?: {
                  dataUrl?: string;
                  label?: string;
                  quote?: string;
                  meaning?: string;
                };
                action?: { kind?: string; label?: string };
              }>;
              const fromSession = entries
                .filter((e) => e.meta?.dataUrl)
                .map((e) => ({
                  dataUrl: e.meta!.dataUrl!,
                  url: e.url || "",
                  label:
                    e.meta?.label ||
                    e.action?.label ||
                    t("overlay.timelapse"),
                  quote: e.meta?.quote,
                  meaning: e.meta?.meaning,
                }));
              if (fromSession.length > 0) {
                setCapturedShots((prev) =>
                  prev.length > 0 ? prev : fromSession,
                );
              }
            } catch {
              /* keep whatever we already captured live */
            }
          })();
        }
        if (
          overlayState === "transcribing" ||
          overlayState === "processing"
        ) {
          setAwaitingNextObjective(false);
          setConfirmNewInvestigation(false);
          onCompleteScreenRef.current = false;
          setShareFrame(null);
          setLiveViewerUrl(null);
          setLiveInteractive(false);
          setAgentStatus("");
        }
        if (overlayState === "recording" || overlayState === "streaming") {
          setShareFrame(null);
          setLiveViewerUrl(null);
          setLiveInteractive(false);
          setAgentStatus("");
          setCapturedShots([]);
          setReplayIndex(0);
        }
        setIsVisible(true);
      });

      const unlistenHide = await listen("hide-overlay", () => {
        setIsVisible(false);
        setAwaitingNextObjective(false);
        setConfirmNewInvestigation(false);
        onCompleteScreenRef.current = false;
        skipObjectivePromptsRef.current = false;
      });

      const unlistenLevel = await listen<number[]>("mic-level", (event) => {
        const newLevels = event.payload as number[];
        // Exponential smoothing across the 16 buckets, then take the first N
        // bars for the shared waveform.
        const smoothed = smoothedLevelsRef.current.map((prev, i) => {
          const target = newLevels[i] || 0;
          return prev * 0.7 + target * 0.3;
        });
        smoothedLevelsRef.current = smoothed;
        setLevels(smoothed.slice(0, WAVE_BARS));
      });

      const unlistenStream = await events.streamTextEvent.listen((event) => {
        setStreamText(event.payload);
      });

      const unlistenPhase = await events.streamPhaseEvent.listen((event) => {
        const payload: StreamPhaseEvent = event.payload;
        setPhase(payload.phase);
        if (payload.kind) setWorkKind(payload.kind);
      });

      const unlistenFrame = await listen<{
        url: string;
        label: string;
        status: string;
        tone?: string;
        highlight?: { x: number; y: number; w: number; h: number };
        dataUrl?: string;
        quote?: string;
        meaning?: string;
      }>("investigation-frame", (event) => {
        setShareFrame((prev) => ({
          ...event.payload,
          // Keep last extraction card until the next extract lands.
          quote: event.payload.quote ?? prev?.quote,
          meaning: event.payload.meaning ?? prev?.meaning,
        }));
        if (event.payload.status) setAgentStatus(event.payload.status);
        // While WebRTC is live, ignore PNG/JPEG frames - they hitch the UI
        // around the iframe. Store shots only in PNG fallback mode.
        if (event.payload.dataUrl && !liveViewerUrlRef.current) {
          setCapturedShots((prev) => {
            const last = prev[prev.length - 1];
            const nextShot = {
              dataUrl: event.payload.dataUrl!,
              url: event.payload.url,
              label: event.payload.label,
              quote: event.payload.quote,
              meaning: event.payload.meaning,
            };
            if (
              last &&
              last.url === event.payload.url &&
              last.label === event.payload.label
            ) {
              return [
                ...prev.slice(0, -1),
                {
                  ...nextShot,
                  quote: event.payload.quote ?? last.quote,
                  meaning: event.payload.meaning ?? last.meaning,
                },
              ];
            }
            return [...prev, nextShot];
          });
        }
      });

      const unlistenAgentStatus = await listen<string>(
        "investigation-status",
        (event) => {
          setAgentStatus(event.payload);
        },
      );

      const unlistenLive = await listen<{
        viewerUrl?: string | null;
        sessionId?: string | null;
      }>("investigation-live", (event) => {
        const url = event.payload.viewerUrl?.trim() || null;
        const wasLive = Boolean(liveViewerUrlRef.current);
        liveViewerUrlRef.current = url;
        setLiveViewerUrl(url);
        if (!url) {
          setLiveInteractive(false);
          // After a live run, hydrate completion replay from sealed session shots
          // (we intentionally didn't stream PNGs during WebRTC).
          if (wasLive) {
            void commands.getInvestigationSession().then((session) => {
              if (!session?.entries_json) return;
              try {
                const entries = JSON.parse(session.entries_json) as Array<{
                  url?: string;
                  action?: { kind?: string; label?: string };
                  meta?: {
                    dataUrl?: string;
                    label?: string;
                    quote?: string;
                    meaning?: string;
                  };
                }>;
                const shots = entries
                  .filter(
                    (e) =>
                      e.action?.kind === "screenshot" &&
                      typeof e.meta?.dataUrl === "string" &&
                      e.meta.dataUrl.startsWith("data:"),
                  )
                  .map((e) => ({
                    dataUrl: e.meta!.dataUrl!,
                    url: e.url || "",
                    label: e.meta?.label || e.action?.label || "Capture",
                    quote: e.meta?.quote,
                    meaning: e.meta?.meaning,
                  }));
                if (shots.length > 0) setCapturedShots(shots);
              } catch {
                /* ignore */
              }
            });
          }
        }
      });

      return () => {
        unlistenShow();
        unlistenHide();
        unlistenLevel();
        unlistenStream();
        unlistenPhase();
        unlistenFrame();
        unlistenAgentStatus();
        unlistenLive();
      };
    };

    setupEventListeners();
  }, []);

  // Auto-advance the completion slideshow through captured Steel screenshots.
  useEffect(() => {
    if (state !== "complete" || !replayPlaying || capturedShots.length < 2) {
      return;
    }
    const id = window.setInterval(() => {
      setReplayIndex((i) => (i + 1) % capturedShots.length);
    }, 1600);
    return () => window.clearInterval(id);
  }, [state, replayPlaying, capturedShots.length]);

  const startRecordingFromComplete = async (mode: "continue" | "redo") => {
    setLevels(Array(WAVE_BARS).fill(0));
    smoothedLevelsRef.current = Array(16).fill(0);
    setConfirmNewInvestigation(false);
    if (mode === "continue") {
      skipObjectivePromptsRef.current = false;
      setPromptIndex(0);
      speechDetectAfterRef.current = Date.now() + SPEECH_DETECT_GRACE_MS;
      setAwaitingNextObjective(true);
    } else {
      // Confirmed Start over - drop the Handy investigation session, fresh run.
      setCapturedShots([]);
      setReplayIndex(0);
      skipObjectivePromptsRef.current = true;
      setAwaitingNextObjective(false);
      void clearInvestigationSession();
    }
    await commands.toggleTranscription();
  };

  const exportInvestigationZip = async () => {
    try {
      const session = await loadInvestigationSession();
      if (!session) {
        window.alert(t("investigation.emptyTitle"));
        return;
      }
      const evidence = evidenceFromSession(session);
      const eventLog = eventLogFromSession(session);
      const integrity = integrityFromSession(session);
      const entries = entriesFromSession(session);
      // Prefer sealed session screenshots; fall back to in-memory replay shots.
      const withShots =
        evidence.some((e) => e.dataUrl) || capturedShots.length === 0
          ? evidence
          : evidence.map((item, i) => {
              const shot = capturedShots[i];
              return shot?.dataUrl ? { ...item, dataUrl: shot.dataUrl } : item;
            });
      await saveInvestigationZip({
        sessionId: session.id,
        title: session.title || t("investigation.kicker"),
        createdAtMs: session.created_at_ms,
        evidence: withShots,
        eventLog,
        integrity,
        entries,
        integrityJson: session.integrity_json || "",
      });
      setConfirmNewInvestigation(false);
    } catch (err) {
      console.error("Investigation export failed", err);
      window.alert(
        t("investigation.exportFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  // Elapsed timer while the Live overlay is visible.
  useEffect(() => {
    if (state !== "streaming" || !isVisible) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [state, isVisible]);

  const nextObjectivePrompts = (() => {
    const value = t("overlay.nextObjectivePrompts", {
      returnObjects: true,
    });
    return Array.isArray(value) && value.every((p) => typeof p === "string")
      ? (value as string[])
      : [t("overlay.nextObjective")];
  })();

  // Rotate sample follow-up prompts until the user starts talking.
  useEffect(() => {
    if (!awaitingNextObjective || !isVisible) return;
    const id = setInterval(() => {
      setPromptIndex((i) => (i + 1) % Math.max(nextObjectivePrompts.length, 1));
    }, PROMPT_ROTATE_MS);
    return () => clearInterval(id);
  }, [awaitingNextObjective, isVisible, nextObjectivePrompts.length]);

  // Once mic levels spike, drop the rotating hints and show the live waveform.
  useEffect(() => {
    if (!awaitingNextObjective || state !== "recording") return;
    if (Date.now() < speechDetectAfterRef.current) return;
    const peak = Math.max(...levels, 0);
    if (peak >= SPEECH_LEVEL_THRESHOLD) {
      setAwaitingNextObjective(false);
    }
  }, [levels, awaitingNextObjective, state]);

  // Stick to the bottom as text streams in - but only while pinned, so a user who
  // has scrolled up to read history isn't yanked back down by the next chunk.
  useLayoutEffect(() => {
    const el = capRef.current;
    if (!el) return;
    // Fade the top edge only once text actually overflows the cap.
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [streamText]);

  // Each fresh streaming session starts pinned to the bottom, fade cleared.
  useEffect(() => {
    pinnedRef.current = true;
    setOverflowing(false);
  }, [session]);

  // Re-pin when the user is within ~a line of the bottom; unpin otherwise.
  const handleStreamScroll = () => {
    const el = capRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
  };

  const fmtTime = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // ---- Shared building blocks (one visual language for every overlay form) ----
  const waveform = (
    <div className="swave">
      {levels.map((v, i) => (
        <i
          key={i}
          style={{
            height: `${Math.max(3, Math.min(18, 3 + Math.pow(v, 0.7) * 15))}px`,
          }}
        />
      ))}
    </div>
  );

  const cancelBtn = (
    <button
      className="sx"
      aria-label="cancel"
      onClick={() => commands.cancelOperation()}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M4 4 L12 12 M12 4 L4 12"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );

  // dot (left) | waveform (center) | timer + cancel (right) - same structure for
  // pill & panel, so the Live morph is a pure width change.
  const listeningRow = (showTimer: boolean, showCancel: boolean) => (
    <div className="sbase">
      <div className="sbase-l">
        <span className="sdot" />
      </div>
      {waveform}
      <div className="sbase-r">
        {showTimer && <span className="stimer">{fmtTime(elapsed)}</span>}
        {showCancel && cancelBtn}
      </div>
    </div>
  );

  // spinner (left) | label (center) | cancel (right) - same 3-zone grid as the
  // listening row, so the label is centered.
  const workingRow = (label: string, showCancel: boolean) => (
    <div className="sbase">
      <div className="sbase-l">
        <span className="sspinner" />
      </div>
      <span className="swork-label">{label}</span>
      <div className="sbase-r">{showCancel && cancelBtn}</div>
    </div>
  );

  // Stable iframe src - do not flip interactive on the URL (that remounts WebRTC).
  // Watch mode uses a pointer shield; Take control removes it.
  const liveEmbedSrc = liveViewerUrl;

  // Screen-share: prefer Steel live WebRTC embed; fall back to PNG screenshots.
  const screenSharePill = (statusLine: string) => {
    const line = agentStatus || statusLine;
    const quote = shareFrame?.quote?.trim();
    const meaning = shareFrame?.meaning?.trim();
    return (
      <div className="sshare-block">
        <div className="sshare" aria-label={t("overlay.screenShare")}>
          <div className="sshare-frame">
            {liveEmbedSrc ? (
              <div
                className={`sshare-live sshare-webrtc ${
                  liveInteractive ? "interactive" : "watching"
                }`}
              >
                <iframe
                  className="sshare-embed"
                  src={liveEmbedSrc}
                  title={t("overlay.screenShareLive")}
                  allow="autoplay; clipboard-read; clipboard-write; encrypted-media; fullscreen"
                  referrerPolicy="no-referrer"
                />
                {!liveInteractive ? (
                  <div
                    className="sshare-watch-shield"
                    aria-hidden="true"
                  />
                ) : null}
                <div className="sshare-chrome">
                  <span className="sshare-url">
                    {shareFrame?.url || t("overlay.screenShareLive")}
                  </span>
                  <span className="sshare-live-badge">
                    {liveInteractive
                      ? t("overlay.liveInteractive")
                      : t("overlay.liveWatching")}
                  </span>
                </div>
              </div>
            ) : shareFrame?.dataUrl ? (
              <div className="sshare-live">
                <img
                  className="sshare-shot"
                  src={shareFrame.dataUrl}
                  alt={shareFrame.label}
                />
                <div className="sshare-chrome">
                  <span className="sshare-url">{shareFrame.url}</span>
                </div>
                {shareFrame.highlight && (
                  <span
                    className="sshare-hl"
                    style={{
                      left: `${shareFrame.highlight.x}%`,
                      top: `${shareFrame.highlight.y}%`,
                      width: `${shareFrame.highlight.w}%`,
                      height: `${shareFrame.highlight.h}%`,
                    }}
                  />
                )}
              </div>
            ) : shareFrame ? (
              <div
                className="sshare-mock"
                style={{ background: shareFrame.tone || undefined }}
              >
                <div className="sshare-chrome">
                  <span className="sshare-url">{shareFrame.url}</span>
                </div>
                <div className="sshare-mock-body">
                  <span className="sshare-mock-label">{shareFrame.label}</span>
                  {shareFrame.highlight && (
                    <span
                      className="sshare-hl"
                      style={{
                        left: `${shareFrame.highlight.x}%`,
                        top: `${shareFrame.highlight.y}%`,
                        width: `${shareFrame.highlight.w}%`,
                        height: `${shareFrame.highlight.h}%`,
                      }}
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="sshare-placeholder">
                <svg
                  className="sshare-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <rect
                    x="2.5"
                    y="4.5"
                    width="19"
                    height="12"
                    rx="2.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <path
                    d="M8 20h8M12 16.5V20"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
                <span className="sshare-label">{t("overlay.screenShare")}</span>
              </div>
            )}
          </div>
          <div className="sstatus" role="status">
            <span
              className={`sstatus-text ${isPaused ? "paused" : "shiny"}`}
            >
              {line}
            </span>
          </div>
        </div>
        {(quote || meaning) && (
          <div className="sextract" aria-label={t("overlay.extractedEvidence")}>
            {quote ? (
              <>
                <span className="sextract-kicker">
                  {t("overlay.extractedQuote")}
                </span>
                <p className="sextract-quote">“{quote}”</p>
              </>
            ) : null}
            {meaning ? (
              <>
                <span className="sextract-kicker sextract-kicker-why">
                  {t("overlay.whyItMatters")}
                </span>
                <p className="sextract-meaning">{meaning}</p>
              </>
            ) : null}
          </div>
        )}
      </div>
    );
  };

  // ---- Completion: screenshot slideshow + investigation actions ----
  if (state === "complete") {
    const shot =
      capturedShots[
        Math.min(replayIndex, Math.max(capturedShots.length - 1, 0))
      ] ?? null;
    const timelapseCard = (
      <div className="sshare-block scomplete-block">
        <div className="sshare scomplete" aria-label={t("overlay.timelapse")}>
          <div className="sshare-frame scomplete-frame">
            {shot ? (
              <div className="scomplete-replay">
                <img
                  className="scomplete-shot"
                  src={shot.dataUrl}
                  alt={shot.label}
                />
                <div className="scomplete-chrome">
                  <span className="scomplete-url">{shot.url}</span>
                  <span className="scomplete-count">
                    {replayIndex + 1}/{capturedShots.length}
                  </span>
                </div>
                <button
                  type="button"
                  className="scomplete-play scomplete-play-overlay"
                  aria-label={
                    replayPlaying
                      ? t("overlay.pause")
                      : t("overlay.replay")
                  }
                  onClick={() => setReplayPlaying((p) => !p)}
                >
                  {replayPlaying ? (
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <rect
                        x="7"
                        y="6"
                        width="3.5"
                        height="12"
                        rx="1"
                        fill="currentColor"
                      />
                      <rect
                        x="13.5"
                        y="6"
                        width="3.5"
                        height="12"
                        rx="1"
                        fill="currentColor"
                      />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M10 8.5 L16.5 12 L10 15.5 Z"
                        fill="currentColor"
                      />
                    </svg>
                  )}
                </button>
                <div className="scomplete-caption">
                  <span className="scomplete-label">{shot.label}</span>
                  <span className="scomplete-sub">
                    {replayPlaying
                      ? t("overlay.timelapsePlaying")
                      : t("overlay.timelapsePaused")}
                  </span>
                </div>
              </div>
            ) : (
              <div className="scomplete-placeholder">
                <div className="scomplete-film" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <span className="scomplete-label">{t("overlay.timelapse")}</span>
                <span className="scomplete-sub">
                  {t("overlay.timelapseEmpty")}
                </span>
              </div>
            )}
          </div>
        </div>
        {(shot?.quote || shot?.meaning) && (
          <div className="sextract" aria-label={t("overlay.extractedEvidence")}>
            {shot.quote ? (
              <>
                <span className="sextract-kicker">
                  {t("overlay.extractedQuote")}
                </span>
                <p className="sextract-quote">“{shot.quote}”</p>
              </>
            ) : null}
            {shot.meaning ? (
              <>
                <span className="sextract-kicker sextract-kicker-why">
                  {t("overlay.whyItMatters")}
                </span>
                <p className="sextract-meaning">{shot.meaning}</p>
              </>
            ) : null}
          </div>
        )}
      </div>
    );

    const shortcutParts = formatKeyCombination(
      transcribeBinding,
      osType,
    )
      .split(" + ")
      .filter(Boolean);

    const completeActions = (
      <div
        className={`scard compact cactions ccomplete ${isVisible ? "" : "leaving"}`}
      >
        <div className="sactions">
          <button
            type="button"
            className="saction saction-primary"
            onClick={() => {
              void (async () => {
                // Ensure latest session is in Rust before seeding the Logseq graph.
                await ensureInvestigationSession();
                const opened = await commands.openInvestigationWindow();
                if (opened.status === "error") {
                  console.error("Open in Logseq failed:", opened.error);
                  return;
                }
                console.info(
                  "Logseq graph + case ZIP ready:",
                  opened.data,
                );
              })();
            }}
          >
            <span>{t("overlay.openInvestigation")}</span>
            <img
              className="saction-icon saction-icon-asset"
              src={openInvestigationIcon}
              alt=""
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            className="saction saction-pause"
            onClick={() => {
              void startRecordingFromComplete("continue");
            }}
          >
            <span>{t("overlay.continue")}</span>
            <span className="saction-keys" aria-hidden="true">
              {shortcutParts.flatMap((part, i) => {
                const nodes = [];
                if (i > 0) {
                  nodes.push(
                    <span key={`plus-${i}`} className="saction-key-plus">
                      +
                    </span>,
                  );
                }
                nodes.push(
                  <kbd key={`${part}-${i}`} className="saction-key">
                    {part}
                  </kbd>,
                );
                return nodes;
              })}
            </span>
          </button>
          <button
            type="button"
            className="saction saction-pause"
            onClick={() => setConfirmNewInvestigation(true)}
          >
            <span>{t("overlay.startOver")}</span>
            <img
              className="saction-icon saction-icon-asset"
              src={replayIcon}
              alt=""
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            className="saction saction-pause"
            onClick={() => {
              void exportInvestigationZip();
            }}
          >
            <span>{t("overlay.export")}</span>
            <img
              className="saction-icon saction-icon-asset"
              src={exportIcon}
              alt=""
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
    );

    const confirmCard = confirmNewInvestigation ? (
      <div
        className="sconfirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="sconfirm-title"
        aria-describedby="sconfirm-body"
      >
        <p id="sconfirm-title" className="sconfirm-title">
          {t("overlay.unsavedTitle")}
        </p>
        <p id="sconfirm-body" className="sconfirm-body">
          {t("overlay.unsavedBody")}
        </p>
        <div className="sconfirm-actions">
          <button
            type="button"
            className="saction saction-primary"
            onClick={() => {
              void exportInvestigationZip();
            }}
          >
            <span>{t("overlay.export")}</span>
            <img
              className="saction-icon saction-icon-asset"
              src={exportIcon}
              alt=""
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            className="saction saction-pause"
            onClick={() => {
              void startRecordingFromComplete("redo");
            }}
          >
            <span>{t("overlay.startOver")}</span>
            <img
              className="saction-icon saction-icon-asset"
              src={replayIcon}
              alt=""
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            className="saction saction-pause"
            onClick={() => setConfirmNewInvestigation(false)}
          >
            <span>{t("overlay.back")}</span>
            <img
              className="saction-icon saction-icon-asset"
              src={backIcon}
              alt=""
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
    ) : null;

    return (
      <div
        dir={direction}
        className={`ov-stage ${position} ov-stack ov-fade ${isVisible ? "show" : ""}`}
      >
        {position === "bottom" ? (
          <>
            {!confirmNewInvestigation && timelapseCard}
            {confirmCard ?? completeActions}
          </>
        ) : (
          <>
            {confirmCard ?? completeActions}
            {!confirmNewInvestigation && timelapseCard}
          </>
        )}
      </div>
    );
  }

  // ---- Post-transcription: screen-share pill + action pill stacked ----
  if (state === "result") {
    const statusLine = isPaused
      ? t("overlay.statusPaused")
      : t("overlay.statusWorking");
    const actionRow = (
      <div className="sactions">
        <button
          type="button"
          className="saction saction-pause"
          onClick={() => setIsPaused((p) => !p)}
        >
          <span>{isPaused ? t("overlay.resume") : t("overlay.pause")}</span>
          {isPaused ? (
            <svg
              className="saction-icon saction-icon-glyph"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              {/* Resume / play triangle */}
              <path d="M5 3.2 L12.8 8 L5 12.8 Z" fill="currentColor" />
            </svg>
          ) : (
            <svg
              className="saction-icon saction-icon-glyph"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              {/* Pause - two vertical bars */}
              <rect
                x="4"
                y="3"
                width="2.75"
                height="10"
                rx="0.9"
                fill="currentColor"
              />
              <rect
                x="9.25"
                y="3"
                width="2.75"
                height="10"
                rx="0.9"
                fill="currentColor"
              />
            </svg>
          )}
        </button>
        <button
          type="button"
          className={`saction saction-primary ${liveInteractive ? "active" : ""}`}
          disabled={!liveViewerUrl}
          onClick={() => {
            if (!liveViewerUrl) return;
            setLiveInteractive((v) => {
              const next = !v;
              void commands.recordInvestigationActor(next ? "human" : "agent");
              return next;
            });
          }}
        >
          <span>
            {liveInteractive
              ? t("overlay.releaseControl")
              : t("overlay.takeControl")}
          </span>
          <img
            className="saction-icon saction-icon-control"
            src={takeControlIcon}
            alt=""
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          className="saction saction-icon-only"
          aria-label={t("overlay.fullscreen")}
        >
          <svg
            className="saction-icon saction-icon-glyph"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            {/* Four corner brackets - fullscreen */}
            <path
              d="M2.5 5.5 V3.5 H4.5 M11.5 3.5 H13.5 V5.5 M13.5 10.5 V12.5 H11.5 M4.5 12.5 H2.5 V10.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    );
    const statusPill = (
      <div className={`scard compact cactions ${isVisible ? "" : "leaving"}`}>
        {actionRow}
      </div>
    );

    return (
      <div
        dir={direction}
        className={`ov-stage ${position} ov-stack ov-fade ${isVisible ? "show" : ""}`}
      >
        {position === "bottom" ? (
          <>
            {screenSharePill(statusLine)}
            {statusPill}
          </>
        ) : (
          <>
            {statusPill}
            {screenSharePill(statusLine)}
          </>
        )}
      </div>
    );
  }

  // ---- Live overlay: a pill that sculpts open into a panel ----
  if (state === "streaming") {
    const hasText =
      streamText.committed.length > 0 || streamText.tentative.length > 0;
    const working = phase === "working";
    // Keep the panel open whenever there's text - even while finalizing - so the
    // transcript stays put under a working spinner instead of collapsing and
    // squishing the text mid-stream. Only fall back to the small working pill
    // when there was no text to preserve.
    const open = hasText;
    const collapsed = working && !hasText;

    return (
      <div dir={direction} className={`ov-stage ${position}`}>
        <div
          key={session}
          className={`scard ${open ? "open" : ""} ${collapsed ? "working" : ""} ${
            isVisible ? "" : "leaving"
          }`}
        >
          <div className="stext">
            <div className="stext-clip">
              <div
                className={`stext-cap ${overflowing ? "overflowing" : ""}`}
                ref={capRef}
                onScroll={handleStreamScroll}
              >
                <p>
                  <span className="committed">
                    {streamText.committed ? streamText.committed + " " : ""}
                  </span>
                  <span className="tentative">{streamText.tentative}</span>
                  {/* Drop the blinking caret once finalizing - it's no longer
                      capturing, and a static spinner conveys the work. */}
                  {!working && <span className="scaret" />}
                </p>
              </div>
            </div>
          </div>
          {working
            ? workingRow(
                workKind === "polishing"
                  ? t("overlay.processing")
                  : t("overlay.transcribing"),
                true,
              )
            : listeningRow(open, true)}
        </div>
      </div>
    );
  }

  // ---- Minimal overlay: exactly one row at a time - waveform (recording), or a
  // spinner + label (transcribing / processing). Never both. The pill animates its
  // width between them; the cancel button is in both rows so it stays put.
  // After completion → Continue, the pill prompts for the next objective instead.
  const working = state === "transcribing" || state === "processing";
  const workLabel =
    state === "processing"
      ? t("overlay.processing")
      : t("overlay.transcribing");
  const activePrompt =
    nextObjectivePrompts[
      promptIndex % Math.max(nextObjectivePrompts.length, 1)
    ] ?? t("overlay.nextObjective");
  const nextObjectiveRow = (
    <div className="sbase">
      <div className="sbase-l">
        <span className="sdot" />
      </div>
      <span className="swork-label swork-prompt" aria-live="polite">
        <span key={promptIndex} className="swork-prompt-text">
          {activePrompt}
        </span>
      </span>
      <div className="sbase-r">{cancelBtn}</div>
    </div>
  );

  return (
    <div
      dir={direction}
      className={`ov-stage ${position} ov-fade ${isVisible ? "show" : ""}`}
    >
      <div
        className={`scard compact ${
          (working || awaitingNextObjective) && isVisible ? "cworking" : ""
        } ${awaitingNextObjective ? "cobjective" : ""}`}
      >
        {working
          ? workingRow(workLabel, true)
          : awaitingNextObjective
            ? nextObjectiveRow
            : listeningRow(false, true)}
      </div>
    </div>
  );
};

export default RecordingOverlay;
