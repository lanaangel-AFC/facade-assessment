// AFC word library + dictation transcription (shared kit — keep identical across apps).
// Source of truth: github.com/lanaangel-AFC/afc-word-library/kit. Copy, don't edit locally.
//
// Reads words.txt from the private library repository (WORD_LIBRARY_TOKEN), keeps the last
// copy in memory and on disk, refreshes hourly, and sends audio + the word list to OpenAI's
// transcription service. Callers fall back to browser dictation when this is unavailable.
import type { Express, Request, Response } from "express";
import fs from "fs";
import path from "path";

export const WORD_LIBRARY_KIT_VERSION = 1;

const REPO = process.env.WORD_LIBRARY_REPO || "lanaangel-AFC/afc-word-library";
const FILE = process.env.WORD_LIBRARY_PATH || "words.txt";
const apiBase = () => (process.env.WORD_LIBRARY_API_BASE || "https://api.github.com").replace(/\/$/, "");
const REFRESH_MS = 60 * 60 * 1000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // OpenAI limit
const MAX_KEYWORDS = 300;

export type SoundAlike = { heard: string; meant: string; note: string };
export type WordLibrary = { terms: string[]; soundAlikes: SoundAlike[] };
export type LibraryStatus = {
  source: "github" | "cache" | "built-in";
  terms: number;
  soundAlikes: number;
  fetchedAt: string | null;
  lastError: string | null;
  canEdit: boolean;
  repo: string;
  editUrl: string;
};

// Used only when GitHub has never been reached and there is no saved copy.
const BUILT_IN = `Fejsa => façade
ceiling => sealant # when talking about joints, beads or caulking
façade
sealant
silicone
backer rod
spandrel
mullion
transom
flashing
coping
parapet
soffit
spalling
efflorescence
delamination
membrane
cladding
curtain wall
IGU
ACP
GRC
BMU`;

/** Parses the words.txt format (see the file's header). Never throws. */
export function parseWordLibrary(text: string): WordLibrary {
  const terms: string[] = [];
  const soundAlikes: SoundAlike[] = [];
  const seen = new Set<string>();
  const addTerm = (t: string) => {
    const clean = t.replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim();
    if (!clean || seen.has(clean.toLowerCase())) return;
    seen.add(clean.toLowerCase());
    terms.push(clean);
  };
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const hashAt = line.indexOf("#");
    const body = (hashAt >= 0 ? line.slice(0, hashAt) : line).trim();
    const note = hashAt >= 0 ? line.slice(hashAt + 1).trim() : "";
    const arrow = body.indexOf("=>");
    if (arrow >= 0) {
      const heard = body.slice(0, arrow).trim();
      const meant = body.slice(arrow + 2).trim();
      if (heard && meant) { soundAlikes.push({ heard, meant, note }); addTerm(meant); }
    } else if (body) {
      addTerm(body);
    }
  }
  return { terms, soundAlikes };
}

/** The keywords and context sentence sent with each recording. */
export function transcriptionContext(lib: WordLibrary, appContext?: string): { keywords: string[]; prompt: string } {
  const keywords = lib.terms.slice(0, MAX_KEYWORDS);
  const hints = lib.soundAlikes
    .map((s) => `"${s.heard}" is usually "${s.meant}"${s.note ? ` (${s.note})` : ""}`)
    .join("; ");
  const prompt = [
    appContext || "A façade consultant dictating site inspection notes about building envelopes, defects and remedial works, in Australian English.",
    hints ? `Common mix-ups: ${hints}.` : "",
  ].filter(Boolean).join(" ").replace(/[<>\r\n]/g, " ").slice(0, 3000);
  return { keywords, prompt };
}

// ---------------------------------------------------------------- library loading
type State = { lib: WordLibrary; status: LibraryStatus; sha: string | null; loading: Promise<void> | null; lastAttempt: number };
let state: State | null = null;

function cacheFile(dataDir: string) { return path.join(dataDir, "word-library-cache.txt"); }

function headers(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "afc-word-library-kit" };
  if (process.env.WORD_LIBRARY_TOKEN) h.Authorization = `Bearer ${process.env.WORD_LIBRARY_TOKEN}`;
  return h;
}

function init(dataDir: string): State {
  if (state) return state;
  let text = BUILT_IN;
  let source: LibraryStatus["source"] = "built-in";
  let fetchedAt: string | null = null;
  try {
    const f = cacheFile(dataDir);
    if (fs.existsSync(f)) { text = fs.readFileSync(f, "utf8"); source = "cache"; fetchedAt = fs.statSync(f).mtime.toISOString(); }
  } catch {}
  const lib = parseWordLibrary(text);
  state = {
    lib, sha: null, loading: null, lastAttempt: 0,
    status: {
      source, terms: lib.terms.length, soundAlikes: lib.soundAlikes.length, fetchedAt, lastError: null,
      canEdit: !!process.env.WORD_LIBRARY_TOKEN, repo: REPO, editUrl: `https://github.com/${REPO}/edit/main/${FILE}`,
    },
  };
  return state;
}

async function refresh(dataDir: string): Promise<void> {
  const s = init(dataDir);
  if (s.loading) return s.loading;
  s.lastAttempt = Date.now();
  s.loading = (async () => {
    if (!process.env.WORD_LIBRARY_TOKEN) { s.status.lastError = "WORD_LIBRARY_TOKEN is not set"; return; }
    try {
      const r = await fetch(`${apiBase()}/repos/${REPO}/contents/${encodeURIComponent(FILE)}`, { headers: headers(), signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      const j: any = await r.json();
      const text = Buffer.from(String(j.content || ""), "base64").toString("utf8");
      s.lib = parseWordLibrary(text);
      s.sha = j.sha || null;
      s.status = { ...s.status, source: "github", terms: s.lib.terms.length, soundAlikes: s.lib.soundAlikes.length, fetchedAt: new Date().toISOString(), lastError: null };
      try { fs.writeFileSync(cacheFile(dataDir), text, "utf8"); } catch {}
    } catch (e: any) {
      s.status.lastError = e?.message || String(e);
    }
  })().finally(() => { s.loading = null; });
  return s.loading;
}

const RETRY_MS = 5 * 60 * 1000; // after a failed read, wait before asking GitHub again

export async function getWordLibrary(dataDir: string, force = false): Promise<{ lib: WordLibrary; status: LibraryStatus }> {
  const s = init(dataDir);
  const stale = !s.status.fetchedAt || s.status.source !== "github" || Date.now() - Date.parse(s.status.fetchedAt) > REFRESH_MS;
  if (force || (stale && Date.now() - s.lastAttempt > RETRY_MS)) await refresh(dataDir);
  s.status.canEdit = !!process.env.WORD_LIBRARY_TOKEN;
  return { lib: s.lib, status: s.status };
}

/** Appends one line to words.txt in the library repository (needs a read/write token). */
export async function addToWordLibrary(dataDir: string, line: string): Promise<{ ok: boolean; message: string }> {
  const clean = line.replace(/[\r\n]/g, " ").trim();
  if (!clean || clean.startsWith("#")) return { ok: false, message: "Nothing to add." };
  if (!process.env.WORD_LIBRARY_TOKEN) return { ok: false, message: "The word library isn't connected on this server." };
  const url = `${apiBase()}/repos/${REPO}/contents/${encodeURIComponent(FILE)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(10000) });
    if (!cur.ok) return { ok: false, message: `Couldn't read the library (GitHub ${cur.status}).` };
    const j: any = await cur.json();
    const text = Buffer.from(String(j.content || ""), "base64").toString("utf8");
    const existing = parseWordLibrary(text);
    const incoming = parseWordLibrary(clean);
    const dupTerm = incoming.soundAlikes.length === 0 && incoming.terms.every((t) => existing.terms.some((e) => e.toLowerCase() === t.toLowerCase()));
    const dupAlike = incoming.soundAlikes.length > 0 && incoming.soundAlikes.every((a) => existing.soundAlikes.some((e) => e.heard.toLowerCase() === a.heard.toLowerCase() && e.meant === a.meant));
    if (dupTerm || dupAlike) return { ok: true, message: "Already in the word library." };
    const next = text.replace(/\s*$/, "\n") + clean + "\n";
    const put = await fetch(url, {
      method: "PUT", headers: { ...headers(), "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ message: `Add "${clean}" from an app`, content: Buffer.from(next, "utf8").toString("base64"), sha: j.sha }),
    });
    if (put.status === 409 || put.status === 422) continue; // edited at the same moment — retry once
    if (put.status === 403 || put.status === 404) return { ok: false, message: "This server's token can only read the library. Add the word on GitHub instead." };
    if (!put.ok) return { ok: false, message: `Couldn't save (GitHub ${put.status}).` };
    await refresh(dataDir);
    return { ok: true, message: `Added "${clean}" to the word library.` };
  }
  return { ok: false, message: "The library was being edited at the same time. Try again." };
}

// ---------------------------------------------------------------- transcription
export async function transcribeAudio(opts: {
  audio: Buffer; mimeType: string; filename: string; apiKey: string; dataDir: string; appContext?: string;
}): Promise<{ text: string; model: string; library: LibraryStatus }> {
  const { lib, status } = await getWordLibrary(opts.dataDir);
  const { keywords, prompt } = transcriptionContext(lib, opts.appContext);
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const send = async (model: string) => {
    const form = new FormData();
    form.append("model", model);
    form.append("file", new Blob([opts.audio], { type: opts.mimeType || "audio/webm" }), opts.filename);
    if (model === "gpt-transcribe") {
      form.append("prompt", prompt);
      for (const k of keywords) form.append("keywords[]", k);
      form.append("languages[]", "en");
    } else {
      // Older models take the word list inside the prompt.
      form.append("prompt", `${prompt} Vocabulary: ${keywords.join(", ")}.`.slice(0, 3500));
      form.append("language", "en");
    }
    return fetch(`${base}/audio/transcriptions`, {
      method: "POST", headers: { Authorization: `Bearer ${opts.apiKey}` }, body: form, signal: AbortSignal.timeout(60000),
    });
  };
  let model = "gpt-transcribe";
  let r = await send(model);
  if (r.status === 400 || r.status === 404) { model = "gpt-4o-transcribe"; r = await send(model); }
  if (!r.ok) throw Object.assign(new Error(`Transcription failed (OpenAI ${r.status})`), { status: 502 });
  const j: any = await r.json();
  return { text: String(j.text || "").trim(), model, library: status };
}

// ---------------------------------------------------------------- routes
/**
 * Registers:
 *   GET  /api/dictation/status       { available, library }
 *   POST /api/dictation/transcribe   raw audio body (Content-Type audio/*) -> { text, model, library }
 *   GET  /api/word-library           { status, terms, soundAlikes }
 *   POST /api/word-library/refresh   re-read from GitHub now
 *   POST /api/word-library/add       { line } -> appends to words.txt
 */
export function registerDictationRoutes(app: Express, opts: {
  dataDir: string;
  getOpenAIKey: () => Promise<string | null | undefined> | string | null | undefined;
  appContext?: string;
  rawBodyParser: (options: { type: string | string[]; limit: number }) => any;
}) {
  const key = async () => (await opts.getOpenAIKey()) || null;

  app.get("/api/dictation/status", async (_req: Request, res: Response) => {
    const { status } = await getWordLibrary(opts.dataDir);
    res.json({ available: !!(await key()), library: status, kitVersion: WORD_LIBRARY_KIT_VERSION });
  });

  const parseAudio = opts.rawBodyParser({ type: ["audio/*", "video/webm", "video/mp4", "application/octet-stream"], limit: MAX_AUDIO_BYTES });
  app.post("/api/dictation/transcribe",
    (req: Request, res: Response, next: () => void) => parseAudio(req, res, (err: any) => {
      if (!err) return next();
      res.status(err.status === 413 ? 413 : 400).json({ message: err.status === 413 ? "That recording is too long. Keep each dictation under about 10 minutes." : "Couldn't read the recording." });
    }),
    async (req: Request, res: Response) => {
      const apiKey = await key();
      if (!apiKey) return res.status(503).json({ message: "Transcription isn't set up on this server." });
      const audio = req.body as Buffer;
      if (!Buffer.isBuffer(audio) || audio.length < 200) return res.status(400).json({ message: "No audio received." });
      const mimeType = String(req.headers["content-type"] || "audio/webm").split(";")[0];
      const ext = mimeType.includes("mp4") || mimeType.includes("m4a") || mimeType.includes("aac") ? "m4a"
        : mimeType.includes("ogg") ? "ogg" : mimeType.includes("wav") ? "wav" : mimeType.includes("mpeg") ? "mp3" : "webm";
      try {
        const out = await transcribeAudio({ audio, mimeType, filename: `dictation.${ext}`, apiKey, dataDir: opts.dataDir, appContext: opts.appContext });
        res.json(out);
      } catch (e: any) {
        res.status(e?.status || 502).json({ message: e?.message || "Transcription failed" });
      }
    });

  app.get("/api/word-library", async (_req: Request, res: Response) => {
    const { lib, status } = await getWordLibrary(opts.dataDir);
    res.json({ status, terms: lib.terms, soundAlikes: lib.soundAlikes });
  });

  app.post("/api/word-library/refresh", async (_req: Request, res: Response) => {
    const { lib, status } = await getWordLibrary(opts.dataDir, true);
    res.json({ status, terms: lib.terms.length, soundAlikes: lib.soundAlikes.length });
  });

  app.post("/api/word-library/add", async (req: Request, res: Response) => {
    const heard = String(req.body?.heard || "").trim();
    const meant = String(req.body?.term || req.body?.meant || "").trim();
    if (!meant) return res.status(400).json({ message: "Enter the correct word." });
    if (/[<>#=]/.test(heard + meant)) return res.status(400).json({ message: "Words can't contain < > # or =." });
    const out = await addToWordLibrary(opts.dataDir, heard ? `${heard} => ${meant}` : meant);
    res.status(out.ok ? 200 : 400).json(out);
  });
}
