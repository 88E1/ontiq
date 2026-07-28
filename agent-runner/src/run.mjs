/**
 * Handy agent sidecar - Steel (isolated browser) + Playwright.
 * Speaks NDJSON on stdout for the Rust bridge.
 *
 * Run with Node (not Bun): Playwright's browser pipe hangs under Bun on Windows.
 *
 * Priority:
 * 1. Self-hosted Steel at STEEL_BASE_URL (default http://localhost:3000)
 * 2. Steel cloud with STEEL_API_KEY
 * 3. Local Playwright Chromium / Edge
 * 4. Mock slideshow fallback
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import Steel from "steel-sdk";
import { createLedger } from "./integrity.mjs";

// Load agent-runner/.env (STEEL_API_KEY etc.) - Node doesn't do this itself,
// and Handy spawns us without a shell profile.
try {
  const envPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    ".env",
  );
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [, key, raw] = m;
      if (process.env[key] !== undefined) continue;
      process.env[key] = raw.replace(/^["']|["']$/g, "");
    }
  }
} catch {
  /* env file is optional */
}

function emit(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

/** Emit a status line and append it to the provenance event log (text-only). */
function pushStatus(entries, state, message, url = "about:blank", meta = {}) {
  const text = String(message || "").trim();
  if (!text) return;
  emit({ type: "status", message: text });
  if (!entries || !state) return;
  state.statusSeq = (state.statusSeq || 0) + 1;
  state.t += 40;
  entries.push({
    id: `prov_status_${state.statusSeq}`,
    t: state.t,
    url: url || "about:blank",
    action: {
      kind: "extract",
      instruction: "status",
      text,
    },
    meta: {
      label: "Status",
      kind: "status",
      finding: text,
      ...meta,
    },
  });
}

function parseObjective(argv) {
  const idx = argv.indexOf("--objective");
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  return process.env.HANDY_OBJECTIVE || "Investigate the current issue";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Shared LLM chat for planner / extract notes.
 * Supports Anthropic (ANTHROPIC_API_KEY) or OpenAI-compatible (OPENAI_API_KEY).
 */
function llmConfig() {
  const anthropicKey =
    process.env.ANTHROPIC_API_KEY || process.env.HANDY_ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY || process.env.HANDY_LLM_API_KEY;
  const provider = (
    process.env.HANDY_LLM_PROVIDER ||
    (anthropicKey ? "anthropic" : openaiKey ? "openai" : "")
  ).toLowerCase();

  if (provider === "anthropic" && anthropicKey) {
    return {
      provider: "anthropic",
      apiKey: anthropicKey,
      base: (
        process.env.ANTHROPIC_BASE_URL ||
        process.env.HANDY_ANTHROPIC_BASE_URL ||
        "https://api.anthropic.com"
      ).replace(/\/$/, ""),
      model: process.env.HANDY_LLM_MODEL || "claude-sonnet-4-5",
    };
  }
  if (openaiKey) {
    return {
      provider: "openai",
      apiKey: openaiKey,
      base: (
        process.env.OPENAI_BASE_URL ||
        process.env.HANDY_LLM_BASE_URL ||
        "https://api.openai.com/v1"
      ).replace(/\/$/, ""),
      model: process.env.HANDY_LLM_MODEL || "gpt-4o-mini",
    };
  }
  return null;
}

async function llmChat({ system, user, temperature = 0.2, json = false }) {
  const cfg = llmConfig();
  if (!cfg) return null;

  if (cfg.provider === "anthropic") {
    const res = await fetch(`${cfg.base}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 1024,
        temperature,
        system: json
          ? `${system}\n\nRespond with valid JSON only. No markdown fences.`
          : system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Anthropic ${res.status}${body ? ` · ${body.slice(0, 120)}` : ""}`);
    }
    const data = await res.json();
    const text = (data?.content || [])
      .filter((b) => b?.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("empty Anthropic response");
    return text;
  }

  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature,
      ...(json ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}${body ? ` · ${body.slice(0, 120)}` : ""}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("empty OpenAI response");
  return text;
}

// Pace for PNG/screenshot Screen share (watchable slideshow).
// Live WebRTC mode uses much shorter settles so the stream stays real-time.
// Override with HANDY_AGENT_PACE_MS (base dwell time in ms).
const PACE = Math.max(
  800,
  Number.parseInt(process.env.HANDY_AGENT_PACE_MS || "2800", 10) || 2800,
);
const PACE_SEARCH = Math.round(PACE * 1.15); // dwell on SERP
const PACE_PAGE = Math.round(PACE * 1.35); // dwell after opening a source
const PACE_BETWEEN = Math.round(PACE * 0.85); // beat between sources
const PACE_TICK = Math.max(PACE + 1200, 4000); // PNG ticker cadence (non-live)
// Live WebRTC: only tiny settles after navigation / highlight.
const LIVE_SETTLE = Math.max(
  80,
  Number.parseInt(process.env.HANDY_LIVE_SETTLE_MS || "180", 10) || 180,
);
const LIVE_DWELL = Math.max(
  120,
  Number.parseInt(process.env.HANDY_LIVE_DWELL_MS || "320", 10) || 320,
);

function hostPath(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

const MOCK_STEPS = [
  {
    url: "https://duckduckgo.com/?q=checkout+error",
    label: "Search results",
    tone: "#3a4554",
    highlight: { x: 18, y: 28, w: 64, h: 22 },
    finding: "Search results for the investigation query.",
    text: "Top results related to the spoken objective.",
    status: "Searching…",
  },
  {
    url: "https://example.com",
    label: "Opened result",
    tone: "#3d4a3f",
    highlight: { x: 12, y: 20, w: 70, h: 30 },
    finding: "Opened the first relevant result page.",
    text: "Page content captured for evidence.",
    status: "Opening top result…",
  },
];

async function runMock(objective) {
  const ledger = createLedger({
    investigationId: `inv_${crypto.randomBytes(6).toString("hex")}`,
    runId: `run_${crypto.randomBytes(6).toString("hex")}`,
    title: objective.slice(0, 80) || "Investigation",
    userAgent: "Handy Mock Browser",
  });
  const entries = [];
  const state = { t: 0, shot: 0, statusSeq: 0, ledger };
  pushStatus(entries, state, `Mock investigation: ${objective}`);
  for (const step of MOCK_STEPS) {
    pushStatus(entries, state, step.status, step.url);
    state.t += 400;
    entries.push({
      id: `prov_nav_${state.shot}`,
      t: state.t,
      url: step.url,
      action: { kind: "navigate", url: step.url },
    });
    ledger.addEvent({
      eventId: `prov_nav_${state.shot}`,
      kind: "provenance:navigate",
      summary: `Navigate · ${step.url}`,
      url: step.url,
      payload: { url: step.url },
    });
    emit({
      type: "frame",
      url: step.url,
      label: step.label,
      tone: step.tone,
      highlight: step.highlight,
      status: step.status,
    });
    state.shot += 1;
    state.t += 200;
    const shotId = `prov_shot_${state.shot}`;
    entries.push({
      id: shotId,
      t: state.t,
      url: step.url,
      action: {
        kind: "screenshot",
        label: step.label,
        screenshotId: `shot_${state.shot}`,
      },
      screenshotId: `shot_${state.shot}`,
      meta: {
        label: step.label,
        tone: step.tone,
        highlight: step.highlight,
        finding: step.finding,
        extractedPreview: step.text,
      },
    });
    ledger.addTextArtifact({
      kind: "extract",
      url: step.url,
      text: step.text || step.finding || step.label,
      label: `Extract · ${step.label}`,
      preview: step.finding,
      eventId: shotId,
    });
    await sleep(900);
  }
  for (const entry of entries) ledger.sealProvenanceEntry(entry);
  const title = objective.slice(0, 80) || "Investigation";
  const integrity = ledger.finalize({ title });
  emit({
    type: "provenance",
    title,
    entries_json: JSON.stringify(entries),
    integrity_json: JSON.stringify(integrity),
  });
  emit({ type: "done" });
}

function steelLiveEmbedUrl(session) {
  // Prefer the low-latency WebRTC debug embed only. sessionViewerUrl is the
  // full Steel app UI and feels sluggish in Screen share.
  const raw =
    session.debugUrl ||
    session.debug_url ||
    session.websocketViewerUrl ||
    null;
  if (!raw) {
    if (session.sessionViewerUrl) {
      emit({
        type: "status",
        message: "Live stream unavailable for this isolated browser session",
      });
    }
    return null;
  }
  try {
    const u = new URL(raw);
    // Keep interactive=true so Take control can enable input without remounting
    // the iframe (overlay blocks pointer events until the user takes control).
    u.searchParams.set("interactive", "true");
    return u.toString();
  } catch {
    const join = raw.includes("?") ? "&" : "?";
    return `${raw}${join}interactive=true`;
  }
}

async function connectSteel() {
  const baseURL =
    process.env.STEEL_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
  const apiKey = process.env.STEEL_API_KEY;

  // Prefer Steel cloud when an API key is present - that's the visible
  // isolated browser we stream into Screen share.
  let useLocal = false;
  if (!apiKey) {
    try {
      const health = await fetch(`${baseURL}/v1/health`, {
        signal: AbortSignal.timeout(1500),
      });
      useLocal = health.ok;
    } catch {
      useLocal = false;
    }
  }

  if (!useLocal && !apiKey) return null;

  const client = useLocal
    ? new Steel({ baseURL })
    : new Steel({ steelAPIKey: apiKey });

  emit({
    type: "status",
    message: useLocal
      ? "Connecting to isolated browser…"
      : "Starting isolated browser…",
  });

  // Match share-screen aspect; longer timeout so multi-source runs don't die mid-flight.
  const createParams = {
    dimensions: { width: 1280, height: 800 },
    timeout: 600_000,
  };
  // Cloud datacenter IPs get CAPTCHA'd by Google/Bing. Residential proxies +
  // captcha solving are on by default for cloud; set HANDY_STEEL_USE_PROXY=0 or
  // HANDY_STEEL_SOLVE_CAPTCHA=0 to disable (saves credits).
  if (!useLocal) {
    const proxyOff = process.env.HANDY_STEEL_USE_PROXY === "0";
    const captchaOff = process.env.HANDY_STEEL_SOLVE_CAPTCHA === "0";
    if (!proxyOff) createParams.useProxy = true;
    if (!captchaOff) createParams.solveCaptcha = true;
  }

  const session = await client.sessions.create(createParams);
  const liveUrl = steelLiveEmbedUrl(session);
  if (liveUrl) {
    emit({
      type: "live",
      viewerUrl: liveUrl,
      sessionId: session.id || null,
    });
    emit({
      type: "status",
      message: "Isolated browser live stream connected",
    });
  }

  let wsUrl = session.websocketUrl;
  if (apiKey && !useLocal) {
    wsUrl += wsUrl.includes("?") ? `&apiKey=${apiKey}` : `?apiKey=${apiKey}`;
  }

  const browser = await chromium.connectOverCDP(wsUrl);
  const context = browser.contexts()[0] || (await browser.newContext());
  let page = context.pages()[0];
  if (!page) page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
  } catch {
    /* some Steel pages lock viewport */
  }

  return {
    browser,
    page,
    label: "Isolated browser",
    viewerUrl: liveUrl,
    sessionId: session.id,
    release: async () => {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
      try {
        await client.sessions.release(session.id);
      } catch {
        /* ignore */
      }
    },
  };
}

async function connectLocalPlaywright() {
  emit({ type: "status", message: "Opening isolated browser…" });

  const executablePath =
    process.env.CHROME_EXECUTABLE_PATH ||
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    undefined;

  const browser = await chromium.launch({
    headless: true,
    timeout: 60_000,
    ...(executablePath ? { executablePath } : {}),
    args: ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });

  return {
    browser,
    page,
    label: "Local Chromium",
    release: async () => {
      await browser.close();
    },
  };
}

async function pushFrame(page, entries, state, status, label, finding, extras = {}) {
  const url = page.url();
  const quote = typeof extras.quote === "string" ? extras.quote : undefined;
  const meaning = typeof extras.meaning === "string" ? extras.meaning : undefined;
  const highlight = extras.highlight || undefined;
  const ledger = state.ledger;
  const live = Boolean(state.live);
  // Live ticker frames are for the overlay only - persisting every PNG in
  // provenance makes Open Investigation IPC hang (multi‑MB session JSON).
  const persistShot =
    extras.persist === true ||
    Boolean(quote) ||
    ["Source", "Follow-up", "Search", "Done"].includes(label);
  // During live WebRTC, CDP screenshots hitch the remote browser and flood the
  // overlay with multi-MB frames. Only capture when we need a sealed evidence shot.
  const needShot =
    !live ||
    Boolean(quote) ||
    label === "Done" ||
    extras.persist === true ||
    extras.forceShot === true;
  let dataUrl;
  let pngBuf;
  if (needShot) {
    try {
      // Prefer JPEG while live - smaller IPC, less hitch than PNG.
      if (live) {
        pngBuf = await page.screenshot({
          type: "jpeg",
          quality: 55,
          fullPage: false,
        });
        dataUrl = `data:image/jpeg;base64,${pngBuf.toString("base64")}`;
      } else {
        pngBuf = await page.screenshot({ type: "png", fullPage: false });
        dataUrl = `data:image/png;base64,${pngBuf.toString("base64")}`;
      }
    } catch {
      /* ignore */
    }
  }
  emit({
    type: "frame",
    url,
    label,
    // Never ship screenshot bytes to the overlay while WebRTC is active.
    dataUrl: live ? undefined : dataUrl,
    status,
    quote,
    meaning,
    highlight,
  });
  state.shot += 1;
  state.t += 400;
  const entryId = `prov_shot_${state.shot}`;
  entries.push({
    id: entryId,
    t: state.t,
    url,
    action: {
      kind: "screenshot",
      label,
      screenshotId: `shot_${state.shot}`,
    },
    screenshotId: `shot_${state.shot}`,
    meta: {
      label,
      dataUrl: persistShot && needShot ? dataUrl : undefined,
      finding: finding || status,
      extractedPreview: quote || hostPath(url),
      quote,
      meaning,
      highlight,
    },
  });
  // Seal meaningful screenshots into the integrity ledger (not every live tick).
  if (ledger && pngBuf && persistShot) {
    ledger.addArtifact({
      kind: "screenshot",
      mimeType: live ? "image/jpeg" : "image/png",
      url,
      data: pngBuf,
      label: `Screenshot · ${label}`,
      preview: finding || status || label,
      eventId: entryId,
    });
  }
}

async function sealPageHtml(page, state, label = "Page HTML") {
  const ledger = state.ledger;
  if (!ledger || !page) return;
  try {
    const html = await page.content();
    ledger.addTextArtifact({
      kind: "html",
      mimeType: "text/html; charset=utf-8",
      url: page.url(),
      text: html,
      label,
      preview: html.replace(/\s+/g, " ").slice(0, 160),
    });
  } catch {
    /* ignore */
  }
}

/** Drop bulky live-capture PNGs before handing session to Handy. */
function compactProvenanceEntries(entries) {
  return (entries || []).map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const meta = entry.meta;
    if (!meta || typeof meta !== "object" || !meta.dataUrl) return entry;
    const keep =
      Boolean(meta.quote) ||
      Boolean(meta.meaning) ||
      ["Source", "Follow-up", "Search", "Done", "Extracted evidence"].includes(
        meta.label,
      );
    if (keep) return entry;
    const { dataUrl: _drop, ...rest } = meta;
    return { ...entry, meta: rest };
  });
}

/** Strip spoken filler so we don't search the raw transcript. */
function stripSpeechFiller(text) {
  let s = text.trim().replace(/\s+/g, " ");
  // Drop leading conversational wrappers (repeat until stable).
  for (let i = 0; i < 4; i++) {
    const next = s
      .replace(
        /^(hey|hi|hello|okay|ok|so|um|uh|please|thanks|thank you)[,.]?\s+/i,
        "",
      )
      .replace(
        /^(can you|could you|would you|will you|i want you to|i need you to|i'd like you to|i would like you to)\s+/i,
        "",
      )
      .replace(
        /^(find(?:\s+me)?|search(?:\s+for)?|look\s+up|look\s+into|investigate|research|check|pull up|get(?:\s+me)?|show(?:\s+me)?|tell\s+me(?:\s+about)?|give\s+me)\s+/i,
        "",
      )
      .replace(
        /^(what(?:'s|\s+is|\s+are)|who(?:'s|\s+is|\s+are)|where(?:'s|\s+is)|how\s+(?:do|does|to|many|much)|which)\s+/i,
        "",
      );
    if (next === s) break;
    s = next;
  }
  return s
    .replace(/\b(and\s+)?(cite|with)\s+(sources?|evidence|proof)\b/gi, "")
    .replace(
      /\b(trace|show|link)\s+(this|the)\s+claim\s+back\s+to\s+primary\s+sources?\b/gi,
      "",
    )
    .replace(/\bplease\b/gi, "")
    .replace(/[?!.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectIntent(text) {
  const low = text.toLowerCase();
  if (
    /\b(board|directors?|directorship|trustees?)\b/.test(low) ||
    /\bsit on\b.*\bboards?\b/.test(low)
  ) {
    return "board";
  }
  if (
    /\b(leadership|executives?|management team|c-suite|ceo|cfo|cto|officers?)\b/.test(
      low,
    )
  ) {
    return "leadership";
  }
  if (/\b(owners?|ownership|shareholders?|investors?|funding|backed by)\b/.test(low)) {
    return "ownership";
  }
  if (/\b(competitors?|vs\.?|versus|alternatives?|compare)\b/.test(low)) {
    return "compare";
  }
  if (/\b(pricing|price|cost|fees?)\b/.test(low)) {
    return "pricing";
  }
  if (/\b(about|company|what does .+ do|overview)\b/.test(low)) {
    return "company";
  }
  return "general";
}

const ROLE_WORDS =
  /^(ceo|cfo|cto|coo|president|chairman|chairwoman|chair|directors?|board|leadership|executives?|officers?|team|company|about)$/i;

function tidyEntity(name) {
  return name
    .replace(/\s+(and|with|who|which|that|is|are|was|were)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull the main entity (company / person / topic) from a cleaned objective.
 * Prefers "CEO/board of X", then "… at/for/about X", else Title Case runs
 * that are not role words.
 */
function extractEntity(cleaned) {
  // "board of directors at X" / "CEO of X" - keep role phrases atomic so
  // "board of …" doesn't swallow "directors" as the entity.
  const roleOf = cleaned.match(
    /\b(?:board\s+of\s+directors|leadership\s+team|executive\s+team|management\s+team|ceo|cfo|cto|coo|president|chairman|chairwoman|chair|directors?|board|leadership|executives?|officers?)\s+(?:of|at|for)\s+([A-Za-z][\w&.''-]*(?:\s+[A-Za-z][\w&.''-]*){0,5})/i,
  );
  if (roleOf?.[1]) {
    const entity = tidyEntity(roleOf[1]);
    if (entity && !ROLE_WORDS.test(entity)) return entity;
  }

  const atMatch = cleaned.match(
    /\b(?:at|for|about|on|from)\s+([A-Z][\w&.''-]*(?:\s+[A-Z][\w&.''-]*){0,5})(?:\s+and\b|\s*$|,)/,
  );
  if (atMatch?.[1]) {
    const entity = tidyEntity(atMatch[1]);
    if (entity && !ROLE_WORDS.test(entity)) return entity;
  }

  // Title Case runs that aren't role labels (skip "CEO", "Board", …).
  const titledRe =
    /\b([A-Z][\w&.''-]*(?:\s+(?:and\s+)?[A-Z][\w&.''-]*){0,5})\b/g;
  let m;
  let best = "";
  while ((m = titledRe.exec(cleaned))) {
    const candidate = tidyEntity(m[1]).replace(/\s+And\s+/g, " and ");
    if (!candidate || ROLE_WORDS.test(candidate)) continue;
    if (candidate.length > best.length) best = candidate;
  }
  if (best.length > 2) return best;

  // Lowercase fallback: drop intent nouns and keep the remainder as the topic.
  const topic = cleaned
    .replace(
      /\b(all|current|the|a|an|official|public|primary|sources?|evidence|list|everything|directors?|board|leadership|team|company|about|who|ceo|cfo|cto|coo|is|are)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return topic.slice(0, 80) || cleaned.slice(0, 80);
}

function buildHeuristicPlan(objective) {
  const raw = objective.trim().replace(/\s+/g, " ");
  const cleaned = stripSpeechFiller(raw) || raw;
  const intent = detectIntent(raw);
  const entity = extractEntity(cleaned);
  const queries = [];
  const questions = [];

  const pushQ = (q) => {
    const t = q.replace(/\s+/g, " ").trim();
    if (t && !queries.includes(t)) queries.push(t);
  };
  const pushQuestion = (q) => {
    const t = q.replace(/\s+/g, " ").trim();
    if (t && !questions.includes(t)) questions.push(t);
  };

  switch (intent) {
    case "board":
      pushQ(`"${entity}" board of directors`);
      pushQ(`"${entity}" directors official site`);
      pushQ(`"${entity}" board members investor relations`);
      pushQuestion(`Who currently sits on the board of directors at ${entity}?`);
      pushQuestion(
        `Which ${entity} directors also serve on other public company boards?`,
      );
      pushQuestion(`Where does ${entity} publish its official board roster?`);
      break;
    case "leadership":
      pushQ(`"${entity}" leadership team`);
      pushQ(`"${entity}" executives officers`);
      pushQ(`"${entity}" CEO CFO official`);
      pushQuestion(`Who are the current executives and officers at ${entity}?`);
      pushQuestion(`What is the leadership structure of ${entity}?`);
      break;
    case "ownership":
      pushQ(`"${entity}" ownership shareholders`);
      pushQ(`"${entity}" investors funding`);
      pushQuestion(`Who owns or controls ${entity}?`);
      pushQuestion(`Who are the major shareholders or backers of ${entity}?`);
      break;
    case "compare":
      pushQ(`${cleaned}`);
      pushQ(`"${entity}" competitors alternatives`);
      pushQuestion(`How does ${entity} compare to its main alternatives?`);
      break;
    case "pricing":
      pushQ(`"${entity}" pricing plans`);
      pushQ(`"${entity}" official pricing`);
      pushQuestion(`What does ${entity} cost, and where is pricing documented?`);
      break;
    case "company":
      pushQ(`"${entity}" company official`);
      pushQ(`"${entity}" about us`);
      pushQuestion(`What is ${entity}, and what does the company do?`);
      break;
    default: {
      // Turn the spoken ask into a crisp topical query - not the transcript.
      const topical = cleaned
        .replace(/\b(and cite sources|with evidence)\b/gi, "")
        .trim();
      pushQ(topical.length > 12 ? topical : `"${entity}"`);
      pushQ(`"${entity}" official`);
      pushQuestion(topical.endsWith("?") ? topical : `${topical}?`);
      pushQuestion(`What primary sources confirm facts about ${entity}?`);
      break;
    }
  }

  const intentLabel = {
    board: "Board of directors",
    leadership: "Leadership",
    ownership: "Ownership",
    compare: "Comparison",
    pricing: "Pricing",
    company: "Company profile",
    general: "Investigation",
  }[intent];

  return {
    title: `${entity} - ${intentLabel}`.slice(0, 80),
    entity,
    intent,
    focus: cleaned,
    primaryQuery: queries[0] || cleaned,
    queries: queries.slice(0, 4),
    questions: questions.slice(0, 4),
  };
}

/**
 * Optional LLM rewrite when ANTHROPIC_API_KEY or OPENAI_API_KEY is set.
 * Falls back to heuristics on any failure.
 */
async function formulateWithLlm(objective) {
  if (!llmConfig()) return null;
  const text = await llmChat({
    temperature: 0.2,
    json: true,
    system:
      "You turn a spoken investigation objective into a research plan. " +
      "Do NOT repeat the user's wording as a search query. " +
      "Return JSON: {" +
      '"title": string, "entity": string, "intent": string, ' +
      '"questions": string[2-4] (clear investigative questions), ' +
      '"queries": string[2-4] (short web search queries, no filler speech)' +
      "}",
    user: objective,
  });
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const parsed = JSON.parse(cleaned);
  const queries = (parsed.queries || [])
    .map((q) => String(q).trim())
    .filter(Boolean);
  const questions = (parsed.questions || [])
    .map((q) => String(q).trim())
    .filter(Boolean);
  if (!queries.length) throw new Error("no queries");
  return {
    title: String(parsed.title || queries[0]).slice(0, 80),
    entity: String(parsed.entity || "").slice(0, 80),
    intent: String(parsed.intent || "general"),
    focus: questions[0] || queries[0],
    primaryQuery: queries[0],
    queries: queries.slice(0, 4),
    questions: questions.slice(0, 4),
  };
}

async function formulateInvestigationPlan(objective) {
  const heuristic = buildHeuristicPlan(objective);
  try {
    const llm = await formulateWithLlm(objective);
    if (llm) {
      emit({
        type: "status",
        message: `Research plan · ${llm.questions[0] || llm.primaryQuery}`,
      });
      return llm;
    }
  } catch (err) {
    emit({
      type: "status",
      message: `Plan fallback · ${String(err).slice(0, 80)}`,
    });
  }
  emit({
    type: "status",
    message: `Research questions · ${heuristic.questions[0] || heuristic.primaryQuery}`,
  });
  return heuristic;
}

function isJunkUrl(href) {
  return /bing\.com|microsoft\.com|msn\.com|duckduckgo\.com|brave\.com\/search|startpage\.com|google\.[^/]+\/search|google\.[^/]+\/aclk|youtube\.com|accounts\.|login\.|signup\.|chrome\.google|play\.google|apps\.apple|aka\.ms|go\.microsoft/i.test(
    href,
  );
}

async function extractPageEvidence(page, objective) {
  return page
    .evaluate((obj) => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const title = document.title || "";
      const origin = location.origin;
      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((a) => ({
          href: a.href,
          text: (a.textContent || "").trim(),
        }))
        .filter((a) => a.href.startsWith("http") && a.text.length > 2);

      // Same-site only, and only leadership/board-ish paths - avoid generic nav.
      const pathHints =
        /\/(board-of-directors|board|directors?|leadership|our-team|team|people|about-us|about|governance|management|executives?|investors?)(\/|$|\?)/i;
      const textHints =
        /^(board of directors|board|directors|leadership|leadership team|our team|executive team)$/i;
      const follow = [];
      const seen = new Set();
      for (const a of links) {
        if (seen.has(a.href)) continue;
        if (!a.href.startsWith(origin)) continue;
        if (/wikipedia\.org|wikidata\.org/i.test(a.href)) continue;
        const hit = pathHints.test(a.href) || textHints.test(a.text.trim());
        if (!hit) continue;
        if (/\/(what-we-offer|learn|content|pricing|blog)(\/|$)/i.test(a.href))
          continue;
        seen.add(a.href);
        follow.push(a);
        if (follow.length >= 2) break;
      }

      const words = obj
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .filter((w) => w.length > 3)
        .slice(0, 8);
      const keyBits =
        /board|director|ceo|chair|chief|executive|leadership|officer|founder|pricing|owner|investor/i;
      const sentences = text
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter((s) => s.length >= 28 && s.length <= 320);

      const scored = sentences
        .map((s) => {
          const low = s.toLowerCase();
          let score = 0;
          if (keyBits.test(low)) score += 4;
          for (const w of words) if (low.includes(w)) score += 2;
          // Prefer concrete name-like content over boilerplate.
          if (/[A-Z][a-z]+ [A-Z][a-z]+/.test(s)) score += 2;
          if (/cookie|subscribe|sign up|privacy policy|terms of use/i.test(low))
            score -= 6;
          return { s, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);

      const quotes = scored.slice(0, 3).map((x) => x.s);
      const hits = scored.slice(0, 8).map((x) => x.s);

      return {
        title,
        preview: (hits.length ? hits.join(" ") : text).slice(0, 900),
        quotes,
        follow,
      };
    }, objective)
    .catch(() => ({ title: "", preview: "", quotes: [], follow: [] }));
}

/**
 * Highlight the exact extracted quote(s) in the live page so the screenshot
 * shows them, and return a viewport-% box for the first match.
 */
async function highlightQuotesOnPage(page, quotes) {
  return page
    .evaluate((quoteList) => {
      // Clear prior Handy marks.
      for (const el of document.querySelectorAll("mark[data-handy-hl]")) {
        const parent = el.parentNode;
        if (!parent) continue;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
        parent.normalize();
      }
      document.querySelectorAll("[data-handy-hl-overlay]").forEach((n) => n.remove());

      let style = document.getElementById("handy-hl-style");
      if (!style) {
        style = document.createElement("style");
        style.id = "handy-hl-style";
        document.documentElement.appendChild(style);
      }
      style.textContent = `
        mark[data-handy-hl] {
          background: rgba(255, 214, 10, 0.55) !important;
          color: inherit !important;
          outline: 2px solid rgba(255, 170, 0, 0.95);
          border-radius: 2px;
          box-decoration-break: clone;
          -webkit-box-decoration-break: clone;
          padding: 0 1px;
        }
      `;

      const norm = (s) => s.replace(/\s+/g, " ").trim();
      const boxes = [];

      const highlightInTextNode = (textNode, start, length) => {
        const text = textNode.textContent || "";
        if (start < 0 || length <= 0 || start + length > text.length) return null;
        const mark = document.createElement("mark");
        mark.setAttribute("data-handy-hl", "1");
        const range = document.createRange();
        range.setStart(textNode, start);
        range.setEnd(textNode, start + length);
        range.surroundContents(mark);
        return mark;
      };

      const findAndMark = (needleRaw) => {
        const needle = norm(needleRaw);
        if (needle.length < 16) return null;

        // Try full quote, then distinctive slices (pages often split sentences).
        const candidates = [
          needle,
          needle.slice(0, Math.min(96, needle.length)),
          needle.slice(0, Math.min(64, needle.length)),
          needle.slice(0, Math.min(40, needle.length)),
        ].filter((c, i, arr) => c.length >= 16 && arr.indexOf(c) === i);

        for (const candidate of candidates) {
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
              acceptNode(node) {
                if (!node.textContent || !node.textContent.trim()) {
                  return NodeFilter.FILTER_REJECT;
                }
                const p = node.parentElement;
                if (!p) return NodeFilter.FILTER_REJECT;
                if (p.closest("script, style, noscript, mark[data-handy-hl]")) {
                  return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
              },
            },
          );

          let node;
          while ((node = walker.nextNode())) {
            const raw = node.textContent || "";
            const collapsed = raw.replace(/\s+/g, " ");
            // Map search in collapsed form back when possible via indexOf on raw-ish.
            let idx = raw.indexOf(candidate);
            if (idx < 0) {
              const lowRaw = raw.toLowerCase();
              const lowCand = candidate.toLowerCase();
              idx = lowRaw.indexOf(lowCand);
            }
            if (idx < 0 && collapsed.toLowerCase().includes(candidate.toLowerCase())) {
              // Fallback: highlight a shorter exact substring present in this node.
              const words = candidate.split(" ").slice(0, 8).join(" ");
              idx = raw.toLowerCase().indexOf(words.toLowerCase());
              if (idx >= 0) {
                const mark = highlightInTextNode(node, idx, words.length);
                if (mark) return mark;
              }
              continue;
            }
            if (idx < 0) continue;
            const mark = highlightInTextNode(node, idx, candidate.length);
            if (mark) return mark;
          }
        }
        return null;
      };

      let first = null;
      for (const q of (quoteList || []).slice(0, 3)) {
        const mark = findAndMark(q);
        if (!mark) continue;
        if (!first) first = mark;
        const rect = mark.getBoundingClientRect();
        const vw = Math.max(window.innerWidth, 1);
        const vh = Math.max(window.innerHeight, 1);
        boxes.push({
          x: Math.max(0, (rect.left / vw) * 100),
          y: Math.max(0, (rect.top / vh) * 100),
          w: Math.min(100, (rect.width / vw) * 100),
          h: Math.min(100, (rect.height / vh) * 100),
        });
      }

      if (first) {
        first.scrollIntoView({ block: "center", inline: "nearest" });
      }

      return {
        highlighted: boxes.length,
        highlight: boxes[0] || null,
      };
    }, quotes)
    .catch(() => ({ highlighted: 0, highlight: null }));
}

/** Pull concrete bits out of a quote so the "why" can cite them. */
function factsFromQuote(quote) {
  const q = (quote || "").replace(/\s+/g, " ").trim();
  // Allow middle initials: "Celeste A. Clark", "Charles W. Scharf"
  const names = [
    ...q.matchAll(
      /\b([A-Z][a-z]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][a-z]+)+)\b/g,
    ),
  ]
    .map((m) => m[1])
    .filter(
      (n) =>
        !/^(Board of|United States|New York|Chief Executive|Managing Director|Mead Johnson)$/i.test(
          n,
        ) && !/^(Director|Chairman|President|Officer)\b/i.test(n),
    );
  const uniqueNames = [...new Set(names)].slice(0, 4);

  // Prefer "Name … role" pairings near each other.
  const people = [];
  for (const name of uniqueNames) {
    const idx = q.indexOf(name);
    if (idx < 0) continue;
    const window = q.slice(Math.max(0, idx - 40), idx + name.length + 60);
    const roleMatch = window.match(
      /\b(chairman|chairwoman|chair(?:person)?|ceo|cfo|cto|coo|president|independent director|lead independent director|director|trustee|chief [a-z]+ officer)\b/i,
    );
    people.push({
      name,
      role: roleMatch ? roleMatch[1] : null,
    });
  }

  const roles = [];
  const roleRe =
    /\b(chairman|chairwoman|chair(?:person)?|ceo|cfo|cto|coo|president|independent director|lead independent director|director|trustee|chief [a-z]+ officer|executive vice president|svp|evp)\b/gi;
  let rm;
  while ((rm = roleRe.exec(q))) {
    const role = rm[1].replace(/\s+/g, " ").trim();
    if (!roles.some((r) => r.toLowerCase() === role.toLowerCase())) {
      roles.push(role);
    }
  }

  const companies = [
    ...q.matchAll(
      /\b(?:of|at|for|from|with|including)\s+([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*){0,4})\b/g,
    ),
  ]
    .map((m) => m[1])
    .filter(
      (c) =>
        c.length > 2 &&
        !uniqueNames.some((n) => n.includes(c) || c.includes(n)),
    );
  const uniqueCompanies = [...new Set(companies)].slice(0, 3);

  const money = q.match(
    /\$[\d,.]+(?:\s*(?:million|billion|thousand|m|bn|k))?|\b\d+(?:\.\d+)?%\b/gi,
  );
  const years = [...q.matchAll(/\b((?:19|20)\d{2})\b/g)].map((m) => m[1]);
  const crossBoard =
    /\b(also serves?|also (?:a |an )?director|sits? on|member of .+ board|other (?:public )?boards?|additional boards?)\b/i.test(
      q,
    );

  return {
    quote: q,
    names: uniqueNames,
    people,
    roles: roles.slice(0, 4),
    companies: uniqueCompanies,
    money: money ? money.slice(0, 3) : [],
    years: [...new Set(years)].slice(0, 2),
    crossBoard,
  };
}

function nameList(names) {
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * Concrete "why it matters" tied to the quote's facts + research questions.
 * Avoids vague "supports the investigation" filler.
 */
function explainExtractionHeuristic(quote, plan, sourceTitle) {
  const entity = plan.entity || "the subject";
  const intent = plan.intent || "general";
  const questions = (plan.questions || []).filter(Boolean);
  const focusQ = questions[0] || plan.focus || plan.title;
  const facts = factsFromQuote(quote);
  const q = facts.quote;
  const via = sourceTitle ? ` (${sourceTitle})` : "";

  if (!q) {
    return `Nothing usable was pulled from this page yet${via}. Next: find a primary source that answers “${focusQ}”.`;
  }

  const primaryPerson = facts.people[0] || null;
  const who =
    facts.people.length > 0
      ? nameList(facts.people.map((p) => p.name).slice(0, 3))
      : facts.names.length > 0
        ? nameList(facts.names)
        : facts.roles.length > 0
          ? `someone listed as ${facts.roles[0]}`
          : null;
  const roleBit = primaryPerson?.role
    ? ` as ${primaryPerson.role}`
    : facts.roles.length > 0
      ? ` as ${facts.roles[0]}`
      : "";
  const otherOrgs = facts.companies.filter(
    (c) => !new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(c),
  );

  if (intent === "board") {
    if (facts.crossBoard && who) {
      return (
        `${who}${roleBit} is connected to ${entity}${via}` +
        (otherOrgs.length
          ? `, with an additional board/org mention of ${nameList(otherOrgs)}`
          : "") +
        `. That is the cross-board link needed for “${questions[1] || focusQ}” - add ${facts.people[0]?.name || "this director"} to the map and verify on both official board pages.`
      );
    }
    if (who && /\b(board|director|chair|trustee)\b/i.test(q)) {
      return (
        `${who}${roleBit || " appears in board/director context"} for ${entity}${via}. ` +
        `Treat this as a candidate answer to “${focusQ}”: confirm the name on ${entity}'s investor/governance page before counting them as a current director.`
      );
    }
    if (/\b(board|director|governance|nominee)\b/i.test(q)) {
      return (
        `This passage names governance details for ${entity}${via} without a clean person↔role pair yet. ` +
        `Use it to locate the official roster page that answers “${focusQ}”, then extract each director individually.`
      );
    }
    return (
      `This page mentions ${entity}${via} but is weak as board proof. ` +
      `Keep it only as a lead toward the primary roster that answers “${focusQ}”.`
    );
  }

  if (intent === "leadership") {
    if (who && facts.roles.length) {
      return (
        `${who} is identified${roleBit} at ${entity}${via}. ` +
        `That directly fills “${focusQ}” - confirm the title is current on the company leadership page, then check whether they also appear in officer filings.`
      );
    }
    if (facts.roles.length) {
      return (
        `A ${facts.roles[0]} role at ${entity} is referenced${via}, but the person is unclear. ` +
        `Follow this to the official bio/leadership list so “${focusQ}” gets a named answer.`
      );
    }
    return (
      `Leadership signal for ${entity}${via} is incomplete. ` +
      `Next source should name the current executive team for “${focusQ}”.`
    );
  }

  if (intent === "ownership") {
    const stake = facts.money.length ? ` (${facts.money.join(", ")})` : "";
    if (who || otherOrgs.length) {
      return (
        `${who || nameList(otherOrgs)} shows up in an ownership/control context for ${entity}${stake}${via}. ` +
        `That changes who we treat as a controlling party when answering “${focusQ}” - verify with a filing or official shareholder disclosure.`
      );
    }
    return (
      `Ownership language around ${entity}${via}${stake} is suggestive, not conclusive. ` +
      `Find the shareholder or investor disclosure that settles “${focusQ}”.`
    );
  }

  if (intent === "pricing") {
    const price = facts.money.length ? facts.money.join(", ") : null;
    if (price) {
      return (
        `The text states pricing terms (${price}) for ${entity}${via}. ` +
        `That is a concrete answer fragment for “${focusQ}” - confirm it on the official pricing page in case this source is outdated or promotional.`
      );
    }
    return (
      `Pricing is discussed for ${entity}${via}, but no clear amount was captured. ` +
      `Open the official plans page and extract the exact numbers for “${focusQ}”.`
    );
  }

  if (intent === "compare") {
    if (otherOrgs.length) {
      return (
        `This contrasts ${entity} with ${nameList(otherOrgs)}${via}. ` +
        `Use the specific claim in the quote as one comparison axis for “${focusQ}”, then verify each side from primary product/docs pages.`
      );
    }
    return (
      `Comparison language about ${entity}${via} needs a named rival and a checkable metric. ` +
      `Pull a second source that states both sides clearly for “${focusQ}”.`
    );
  }

  // General: still be specific about what the quote contributes.
  if (who && facts.roles.length) {
    return (
      `${who}${roleBit} is a concrete fact about ${entity}${via}. ` +
      `It advances “${focusQ}” only if we can re-confirm that role on a primary page; otherwise treat the name as a lead, not a conclusion.`
    );
  }
  if (who) {
    return (
      `${who} is named in connection with ${entity}${via}. ` +
      `Decide whether they are material to “${focusQ}”; if yes, find their official title/affiliation next.`
    );
  }
  if (facts.money.length) {
    return (
      `Numeric detail (${facts.money.join(", ")}) about ${entity}${via} can answer part of “${focusQ}”, but only after matching it to an official or filing-backed figure.`
    );
  }
  if (facts.years.length) {
    return (
      `This is time-stamped (${facts.years.join(", ")})${via}. ` +
      `It matters for “${focusQ}” only if the date is still current - prefer a newer primary source if the claim is older.`
    );
  }

  // Last resort: quote a short clause, still give a next investigative step.
  const snippet = q.length > 110 ? `${q.slice(0, 107)}…` : q;
  return (
    `The claim “${snippet}”${via} is relevant to “${focusQ}” only as a lead. ` +
    `Next: find the primary page that either confirms or contradicts that specific statement about ${entity}.`
  );
}

async function explainExtractionWithLlm(quote, plan, sourceTitle) {
  if (!llmConfig() || !quote?.trim()) return null;
  const text = await llmChat({
    temperature: 0.3,
    system:
      "You write a single 'Why it matters' note for an investigation workbench. " +
      "2-3 sentences max. Be specific: name people/roles/numbers from the quote, " +
      "say how that changes the answer to the research question, and what to verify next. " +
      "Never say vague lines like 'supports the investigation' or 'bears on'. " +
      "No markdown, no bullet points.",
    user: JSON.stringify({
      entity: plan.entity,
      intent: plan.intent,
      researchQuestions: plan.questions,
      sourceTitle: sourceTitle || null,
      extractedQuote: quote,
    }),
  });
  if (!text || text.length < 40) return null;
  return text.slice(0, 420);
}

async function explainExtraction(quote, plan, sourceTitle) {
  try {
    const llm = await explainExtractionWithLlm(quote, plan, sourceTitle);
    if (llm) return llm;
  } catch {
    /* fall through */
  }
  return explainExtractionHeuristic(quote, plan, sourceTitle);
}

async function scrapeSearchResults(page) {
  return page
    .evaluate(() => {
      const bad =
        /bing\.com|microsoft\.com|msn\.com|duckduckgo|brave\.com\/search|startpage\.com|google\.|youtube\.|accounts\.|login\./i;
      const out = [];
      const push = (title, href, blurb) => {
        if (!href || !/^https?:/i.test(href) || bad.test(href)) return;
        if (out.some((x) => x.url === href)) return;
        out.push({
          title: (title || href).trim().slice(0, 140),
          url: href,
          blurb: (blurb || "").trim().slice(0, 220),
        });
      };

      // Google
      for (const row of document.querySelectorAll(
        "#search .g, #rso .g, div[data-sokoban-container]",
      )) {
        const a = row.querySelector("a[href^='http']");
        const blurb =
          row.querySelector(
            "[data-sncf], .VwiC3b, .IsZvec, .aCOpRe, span[style*='-webkit-line-clamp']",
          )?.textContent || "";
        if (a) push(a.textContent || a.innerText, a.href, blurb);
      }
      // Google often wraps titles in h3
      if (out.length === 0) {
        for (const h3 of document.querySelectorAll("#search h3, #rso h3")) {
          const a = h3.closest("a") || h3.parentElement?.closest("a");
          if (!a) continue;
          const parent = h3.closest(".g, div") || a.parentElement;
          const blurb =
            parent?.querySelector(".VwiC3b, .IsZvec, .aCOpRe")?.textContent ||
            "";
          push(h3.textContent, a.href, blurb);
        }
      }

      // Startpage (Google results, privacy front-end)
      for (const row of document.querySelectorAll(
        ".w-gl__result, .result, [class*='result-item'], li.result",
      )) {
        const a =
          row.querySelector(
            "a.w-gl__result-title, a.result-link, a[href^='http']:not([href*='startpage.com'])",
          ) || row.querySelector("h2 a, h3 a");
        const blurb =
          row.querySelector(
            ".w-gl__description, .result-desc, .description, p",
          )?.textContent || "";
        if (a) push(a.textContent, a.href, blurb);
      }
      // Startpage sometimes exposes target via data attributes / redirect params.
      if (out.length === 0) {
        for (const a of document.querySelectorAll(
          "a[href*='startpage.com/do/'], a[href*='startpage.com/sp/']",
        )) {
          try {
            const u = new URL(a.href);
            const target =
              u.searchParams.get("url") ||
              u.searchParams.get("u") ||
              u.searchParams.get("query");
            if (target && /^https?:/i.test(target)) {
              push(a.textContent, target, "");
            }
          } catch {
            /* ignore */
          }
        }
      }

      // Bing
      for (const row of document.querySelectorAll("#b_results .b_algo")) {
        const a = row.querySelector("h2 a");
        const blurb =
          row.querySelector(".b_caption p, .b_lineclamp2, .b_lineclamp3")
            ?.textContent || "";
        if (a) push(a.textContent, a.href, blurb);
      }

      // Brave
      for (const a of document.querySelectorAll(
        "a[data-type='web'][href^='http'], .snippet a[href^='http'], main a[href^='http']",
      )) {
        const title = a.textContent || "";
        if (title.length < 8) continue;
        const parent = a.closest("div, article, li") || a.parentElement;
        const blurb =
          parent?.querySelector("p, .snippet-description, .snippet-content")
            ?.textContent || "";
        push(title, a.href, blurb);
      }

      // DuckDuckGo
      for (const row of document.querySelectorAll(
        "[data-testid='result'], .result, article[data-testid='result']",
      )) {
        const a =
          row.querySelector("a[data-testid='result-title-a'], h2 a, a[href^='http']") ||
          null;
        const blurb =
          row.querySelector(
            "[data-result='snippet'], .result__snippet, .result-snippet",
          )?.textContent || "";
        if (a) push(a.textContent, a.href, blurb);
      }
      if (out.length === 0) {
        for (const a of document.querySelectorAll(
          "#links .result__a, a.result__a, a[data-testid='result-title-a']",
        )) {
          push(a.textContent, a.href, "");
        }
      }

      // Generic fallback
      if (out.length === 0) {
        for (const a of document.querySelectorAll("a[href^='http']")) {
          const title = (a.textContent || "").trim();
          if (title.length < 12) continue;
          push(title, a.href, "");
          if (out.length >= 10) break;
        }
      }

      return out.slice(0, 10);
    })
    .catch(() => []);
}

function rankTargets(targets, term) {
  const low = term.toLowerCase();
  const tokens = low.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const score = (t) => {
    let s = 0;
    const hay = `${t.title} ${t.url} ${t.blurb || ""}`.toLowerCase();
    for (const tok of tokens) if (hay.includes(tok)) s += 2;
    if (/linkedin\.com|crunchbase\.com|bloomberg\.com|reuters\.com|wsj\.com|ft\.com/i.test(t.url))
      s += 3;
    if (/\/(about|leadership|team|board|directors|company|investors)/i.test(t.url))
      s += 4;
    if (/wikipedia\.org|wikidata\.org/i.test(t.url)) s -= 6; // deprioritize wiki
    if (isJunkUrl(t.url)) s -= 20;
    return s;
  };
  return [...targets].sort((a, b) => score(b) - score(a));
}

async function searchTheWeb(page, term, entries, state) {
  // Prefer engines that are less aggressive toward automated / cloud browsers.
  // Google is last - shared cloud IPs almost always get a bot challenge.
  const engines = [
    {
      name: "DuckDuckGo",
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(term)}`,
    },
    {
      name: "Brave",
      url: `https://search.brave.com/search?q=${encodeURIComponent(term)}`,
    },
    {
      name: "Startpage",
      url: `https://www.startpage.com/sp/search?query=${encodeURIComponent(term)}`,
    },
    {
      name: "Bing",
      url: `https://www.bing.com/search?q=${encodeURIComponent(term)}`,
    },
    {
      name: "Google",
      url: `https://www.google.com/search?q=${encodeURIComponent(term)}&hl=en`,
    },
  ];

  const live = Boolean(state?.live);
  for (const engine of engines) {
    pushStatus(
      entries,
      state,
      `Searching ${engine.name} for: ${term}`,
      engine.url,
    );
    try {
      await page.goto(engine.url, {
        waitUntil: "domcontentloaded",
        timeout: 35_000,
      });
      await Promise.race([
        page
          .waitForLoadState("networkidle", {
            timeout: live ? 1_200 : 3_500,
          })
          .catch(() => undefined),
        sleep(live ? LIVE_SETTLE : 900),
      ]);
    } catch (err) {
      pushStatus(
        entries,
        state,
        `${engine.name} failed · ${String(err).slice(0, 80)}`,
        engine.url,
      );
      continue;
    }
    if (!live) await sleep(Math.round(PACE_SEARCH * 0.75));
    else await sleep(LIVE_SETTLE);
    const results = await scrapeSearchResults(page);
    if (results.length > 0) {
      pushStatus(
        entries,
        state,
        `${engine.name} returned ${results.length} leads`,
        page.url(),
      );
      return { engine: engine.name, results };
    }
    pushStatus(
      entries,
      state,
      `${engine.name} returned no usable results`,
      page.url(),
    );
  }
  return { engine: "none", results: [] };
}

async function investigateWithPage(page, objective, options = {}) {
  const entries = options.entries || [];
  const ledger =
    options.ledger ||
    createLedger({
      investigationId: options.investigationId,
      runId: options.runId,
      browserSessionId: options.browserSessionId || "",
      title: "Investigation",
      userAgent: options.userAgent || "",
      viewerUrl: options.viewerUrl || null,
    });
  const state = options.state || { t: 0, shot: 0, statusSeq: 0 };
  state.ledger = ledger;
  const findings = [];
  const plan = await formulateInvestigationPlan(objective);
  const term = plan.primaryQuery;
  const rankingTerm = [plan.entity, plan.focus, ...plan.queries]
    .filter(Boolean)
    .join(" ");
  const visited = new Set();
  const hasLiveStream = Boolean(options.viewerUrl);
  state.live = hasLiveStream;
  // With Steel live WebRTC in Screen share, we don't need a screenshot ticker.
  const tickMs = hasLiveStream
    ? Math.max(PACE_TICK * 2.5, 10_000)
    : PACE_TICK;

  pushStatus(
    entries,
    state,
    hasLiveStream
      ? `Investigating live · ${plan.title}`
      : `Investigating · ${plan.title}`,
  );

  // Record the formulated plan in provenance (not the raw spoken paste).
  state.t += 100;
  entries.push({
    id: "prov_plan",
    t: state.t,
    url: "about:blank",
    action: {
      kind: "extract",
      instruction: "Formulate investigation questions from spoken objective",
      text: [
        `Objective: ${objective.trim()}`,
        "",
        "Research questions:",
        ...plan.questions.map((q, i) => `${i + 1}. ${q}`),
        "",
        "Search queries:",
        ...plan.queries.map((q, i) => `${i + 1}. ${q}`),
      ].join("\n"),
    },
    meta: {
      label: "Research plan",
      kind: "plan",
      finding: plan.questions[0] || plan.primaryQuery,
      extractedPreview: plan.questions.join(" · "),
    },
  });
  pushStatus(
    entries,
    state,
    `Plan ready · ${plan.queries.length} quer${plan.queries.length === 1 ? "y" : "ies"}`,
  );
  ledger.setTitle(plan.title || objective.slice(0, 80) || "Investigation");
  ledger.addTextArtifact({
    kind: "extract",
    mimeType: "text/plain; charset=utf-8",
    url: "",
    text: [
      `Objective: ${objective.trim()}`,
      ...plan.questions.map((q, i) => `Q${i + 1}: ${q}`),
      ...plan.queries.map((q, i) => `Query${i + 1}: ${q}`),
    ].join("\n"),
    label: "Research plan",
    preview: plan.questions[0] || plan.primaryQuery,
    eventId: "prov_plan",
  });

  let tickerBusy = false;
  const ticker = setInterval(() => {
    // Live Steel iframe already shows the browser - skip spammy PNG ticks.
    if (hasLiveStream || tickerBusy) return;
    tickerBusy = true;
    void pushFrame(page, entries, state, "Capturing…", "Live")
      .catch(() => undefined)
      .finally(() => {
        tickerBusy = false;
      });
  }, tickMs);

  const visitSource = async (target, depth = 0) => {
    if (!target?.url || visited.has(target.url) || isJunkUrl(target.url)) return;
    visited.add(target.url);

    state.t += 200;
    entries.push({
      id: `prov_nav_${visited.size}`,
      t: state.t,
      url: target.url,
      action: { kind: "navigate", url: target.url },
    });

    pushStatus(
      entries,
      state,
      `Opening: ${target.title || hostPath(target.url)}…`,
      target.url,
    );

    try {
      await page.goto(target.url, {
        waitUntil: "domcontentloaded",
        timeout: 35_000,
      });
      // Brief settle without waiting forever on long-polling pages.
      await Promise.race([
        page
          .waitForLoadState("networkidle", {
            timeout: hasLiveStream ? 1_500 : 4_000,
          })
          .catch(() => undefined),
        sleep(hasLiveStream ? LIVE_SETTLE : 1_200),
      ]);
    } catch (err) {
      pushStatus(
        entries,
        state,
        `Could not open ${hostPath(target.url)} · ${String(err).slice(0, 80)}`,
        target.url,
      );
      return;
    }

    // Live: keep moving so WebRTC shows real navigation; PNG mode dwells.
    await sleep(hasLiveStream ? LIVE_DWELL : PACE_PAGE);
    await sealPageHtml(
      page,
      state,
      depth === 0 ? "Source HTML" : "Follow-up HTML",
    );
    // Mid-visit capture is for PNG slideshow only - live already shows the page.
    if (!hasLiveStream) {
      await pushFrame(
        page,
        entries,
        state,
        `Viewing ${hostPath(page.url())}`,
        depth === 0 ? "Source" : "Follow-up",
      );
      await sleep(Math.round(PACE * 0.55));
    } else {
      emit({
        type: "frame",
        url: page.url(),
        label: depth === 0 ? "Source" : "Follow-up",
        status: `Viewing ${hostPath(page.url())}`,
      });
    }

    const evidence = await extractPageEvidence(page, rankingTerm);
    const quotes = Array.isArray(evidence.quotes)
      ? evidence.quotes.filter(Boolean)
      : [];
    const quote =
      quotes[0] ||
      (evidence.preview || "").split(/(?<=[.!?])\s+/).find((s) => s.length > 24) ||
      "";
    const meaning = await explainExtraction(
      quote,
      plan,
      evidence.title || target.title,
    );
    const finding = quote || evidence.preview?.slice(0, 280) ||
      `Reviewed ${evidence.title || target.title}`;

    findings.push({
      url: page.url(),
      title: evidence.title || target.title,
      text: finding,
      quote,
      meaning,
    });

    // Highlight the exact extracted passage in the Steel page, then capture it.
    pushStatus(
      entries,
      state,
      quote
        ? `Highlighting evidence on ${hostPath(page.url())}`
        : `Reading: ${evidence.title || hostPath(page.url())}`,
      page.url(),
    );
    const hl = quote
      ? await highlightQuotesOnPage(page, quotes.length ? quotes : [quote])
      : { highlighted: 0, highlight: null };
    await sleep(hasLiveStream ? LIVE_SETTLE : Math.round(PACE * 0.35));

    state.t += 200;
    const extractId = `prov_ext_${visited.size}`;
    const extractText = [quote, "", "Why it matters:", meaning]
      .filter(Boolean)
      .join("\n");
    entries.push({
      id: extractId,
      t: state.t,
      url: page.url(),
      action: {
        kind: "extract",
        instruction: plan.questions?.[0] || objective,
        text: extractText,
      },
      meta: {
        label: "Extracted evidence",
        kind: "extract",
        quote,
        meaning,
        finding: meaning,
        extractedPreview: quote,
        highlight: hl.highlight || undefined,
      },
    });
    ledger.addTextArtifact({
      kind: "extract",
      url: page.url(),
      text: extractText || evidence.preview || finding,
      label: "Extracted evidence",
      preview: quote || meaning,
      eventId: extractId,
    });

    await pushFrame(
      page,
      entries,
      state,
      quote ? "Extracted & highlighted" : `Reviewed ${hostPath(page.url())}`,
      depth === 0 ? "Source" : "Follow-up",
      finding,
      {
        quote: quote || undefined,
        meaning,
        highlight: hl.highlight || undefined,
        // One sealed evidence shot per source while live (JPEG, not sent to overlay).
        forceShot: hasLiveStream && Boolean(quote),
      },
    );
    // Brief beat after highlight so the live stream can show the mark.
    await sleep(hasLiveStream ? LIVE_DWELL : Math.round(PACE_BETWEEN * 1.35));

    // Dig one level deeper into leadership/about pages on promising domains.
    if (depth === 0 && evidence.follow?.length) {
      for (const next of evidence.follow.slice(0, 2)) {
        if (visited.size >= 6) break;
        await visitSource(
          { url: next.href, title: next.text || next.href },
          1,
        );
      }
    }
  };

  try {
    // 1) Search with formulated queries (never the raw spoken transcript).
    let targets = [];
    let lastEngine = "none";
    for (const query of plan.queries) {
      const { engine, results } = await searchTheWeb(
        page,
        query,
        entries,
        state,
      );
      lastEngine = engine;
      state.t += 200;
      entries.push({
        id: `prov_nav_search_${entries.length}`,
        t: state.t,
        url: page.url(),
        action: { kind: "navigate", url: page.url() },
        meta: {
          label: "Search",
          kind: "navigate",
          finding: plan.questions[0] || query,
          extractedPreview: query,
        },
      });
      await sealPageHtml(page, state, `Search HTML · ${engine}`);
      if (hasLiveStream) {
        emit({
          type: "frame",
          url: page.url(),
          label: "Search",
          status: results.length
            ? `${engine} · ${results.length} leads for “${query}”`
            : `Searched: ${query}`,
        });
      } else {
        await pushFrame(
          page,
          entries,
          state,
          results.length
            ? `${engine} · ${results.length} leads for “${query}”`
            : `Searched: ${query}`,
          "Search",
          plan.questions[0] || query,
        );
      }
      await sleep(hasLiveStream ? LIVE_SETTLE : PACE_BETWEEN);

      const ranked = rankTargets(results, rankingTerm);
      for (const hit of ranked) {
        if (targets.some((t) => t.url === hit.url)) continue;
        targets.push(hit);
      }
      // First query with solid hits is enough to start visiting; keep one more
      // query only when we still lack diversity.
      if (targets.length >= 4) break;
    }

    targets = rankTargets(targets, rankingTerm).slice(0, 5);

    pushStatus(
      entries,
      state,
      targets.length > 0
        ? `Following ${Math.min(targets.length, 4)} sources for: ${plan.questions[0] || plan.title}`
        : `No search hits · ${lastEngine} · ${term}`,
    );

    // 2) Visit ranked sources and follow leadership/about links.
    for (const target of targets.slice(0, 4)) {
      if (visited.size >= 6) break;
      await visitSource(target, 0);
    }

    // 3) Final synthesis entry for the workbench.
    const summaryParts = [
      "Research questions:",
      ...plan.questions.map((q, i) => `${i + 1}. ${q}`),
      "",
      findings.length > 0
        ? "Evidence:"
        : `No strong sources found for: ${plan.title}`,
      ...findings.map(
        (f, i) => `${i + 1}. ${f.title}\n${f.text}\n(${f.url})`,
      ),
    ];
    const summary = summaryParts.join("\n");

    state.t += 200;
    entries.push({
      id: "prov_extract_final",
      t: state.t,
      url: page.url(),
      action: {
        kind: "extract",
        instruction: plan.questions.join(" | ") || objective,
        text: summary.slice(0, 2500),
      },
      meta: {
        label: "Synthesis",
        kind: "extract",
        finding: summary.slice(0, 280),
      },
    });

    await pushFrame(
      page,
      entries,
      state,
      `Investigation complete · ${findings.length} source${findings.length === 1 ? "" : "s"}`,
      "Done",
      summary.slice(0, 280),
    );
    pushStatus(
      entries,
      state,
      `Investigation complete · ${findings.length} source${findings.length === 1 ? "" : "s"}`,
      page.url(),
    );
  } finally {
    clearInterval(ticker);
  }

  // Seal every provenance row into the tamper-evident chain, then emit.
  for (const entry of compactProvenanceEntries(entries)) {
    ledger.sealProvenanceEntry(entry);
  }
  const title = plan.title || objective.slice(0, 80) || "Investigation";
  const integrity = ledger.finalize({ title });
  emit({
    type: "provenance",
    title,
    entries_json: JSON.stringify(compactProvenanceEntries(entries)),
    integrity_json: JSON.stringify(integrity),
  });
  emit({ type: "done" });
}

async function runBrowserInvestigation(objective) {
  const investigationId = `inv_${crypto.randomBytes(6).toString("hex")}`;
  const runId = `run_${crypto.randomBytes(6).toString("hex")}`;
  const ledger = createLedger({ investigationId, runId, title: "Investigation" });
  const entries = [];
  const state = { t: 0, shot: 0, statusSeq: 0, ledger, live: false };
  let session = null;
  try {
    pushStatus(entries, state, "Starting isolated browser…");
    session = await connectSteel();
  } catch (err) {
    pushStatus(
      entries,
      state,
      `Isolated browser connect failed · ${String(err).slice(0, 100)}`,
    );
  }

  if (!session) {
    if (!process.env.STEEL_API_KEY) {
      pushStatus(
        entries,
        state,
        "Cloud browser unavailable - falling back to local Chromium",
      );
    }
    pushStatus(entries, state, "Opening isolated browser…");
    session = await connectLocalPlaywright();
  }

  let userAgent = "";
  try {
    userAgent = await session.page.evaluate(() => navigator.userAgent);
  } catch {
    userAgent = "";
  }
  ledger.setBrowserSession(session.sessionId || "", {
    viewerUrl: session.viewerUrl || null,
    userAgent,
    autoCaptcha: process.env.HANDY_STEEL_SOLVE_CAPTCHA !== "0",
    proxyEnabled:
      Boolean(session.sessionId) && process.env.HANDY_STEEL_USE_PROXY !== "0",
  });
  state.live = Boolean(session.viewerUrl);

  pushStatus(
    entries,
    state,
    session.viewerUrl
      ? `${session.label} live - investigating…`
      : `${session.label} ready - investigating…`,
  );
  if (session.sessionId) {
    pushStatus(
      entries,
      state,
      `Browser session ${session.sessionId}`,
      "about:blank",
      { browserSessionId: session.sessionId },
    );
  }

  try {
    await investigateWithPage(session.page, objective, {
      viewerUrl: session.viewerUrl || null,
      entries,
      state,
      ledger,
      investigationId,
      runId,
      browserSessionId: session.sessionId || "",
      userAgent,
    });
  } finally {
    emit({ type: "live", viewerUrl: null, sessionId: null });
    await session.release();
  }
}

async function main() {
  const objective = parseObjective(process.argv.slice(2));
  if (process.env.HANDY_FORCE_MOCK === "1") {
    await runMock(objective);
    return;
  }
  try {
    await runBrowserInvestigation(objective);
  } catch (err) {
    // Fall back to mock; keep a short status for the overlay (no session yet).
    emit({
      type: "status",
      message: `Browser unavailable, using mock · ${String(err).slice(0, 120)}`,
    });
    await runMock(objective);
  }
}

main().catch((err) => {
  emit({ type: "error", message: String(err) });
  process.exitCode = 1;
});
