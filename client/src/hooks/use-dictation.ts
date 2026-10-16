// AFC dictation hook (shared kit — keep identical across apps).
// Source of truth: github.com/lanaangel-AFC/afc-word-library/kit. Copy, don't edit locally.
//
// Tap to start, tap to stop. Records audio and sends it to this app's server, which
// transcribes it with the shared word library. If that isn't available (no OpenAI key,
// no microphone recording support, or the upload fails) it uses the browser's own
// speech recognition, exactly as before, without the library.
import { useState, useRef, useCallback, useEffect } from "react";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
const MAX_RECORDING_MS = 2 * 60 * 1000;

type Mode = "library" | "browser";
export type DictationNotice = { kind: "fallback" | "error"; message: string };

// Shared by every microphone button on the page.
let statusPromise: Promise<boolean> | null = null;
let libraryAvailable: boolean | null = null;
let browserOnlyUntil = 0; // after a failed upload, use browser dictation for a while

function loadStatus(): Promise<boolean> {
  if (!statusPromise) {
    statusPromise = fetch(`${API_BASE}/api/dictation/status`)
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then((j) => { libraryAvailable = !!j?.available; return libraryAvailable; })
      .catch(() => { libraryAvailable = false; statusPromise = null; return false; });
  }
  return statusPromise;
}

function browserSpeech(): any {
  if (typeof window === "undefined") return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

function canRecord(): boolean {
  return typeof window !== "undefined" && typeof (window as any).MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

function pickMimeType(): string {
  const MR = (window as any).MediaRecorder;
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    try { if (MR.isTypeSupported?.(t)) return t; } catch {}
  }
  return "";
}

export function useDictation(
  onResult: (text: string) => void,
  options?: { continuous?: boolean; lang?: string; onNotice?: (n: DictationNotice) => void }
) {
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);
  const recognitionRef = useRef<any>(null);
  const recorderRef = useRef<any>(null);
  const timerRef = useRef<any>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const noticeRef = useRef(options?.onNotice);
  noticeRef.current = options?.onNotice;
  const notify = (n: DictationNotice) => noticeRef.current?.(n);

  const isSupported = typeof window !== "undefined" && (!!browserSpeech() || canRecord());

  // Learn whether the word library is available before the first tap, so the tap itself
  // can start recording straight away (Safari needs that to happen inside the tap).
  useEffect(() => { if (canRecord()) loadStatus(); }, []);

  useEffect(() => () => {
    clearTimeout(timerRef.current);
    try { recognitionRef.current?.stop(); } catch {}
    try { if (recorderRef.current?.state === "recording") recorderRef.current.stop(); } catch {}
  }, []);

  const startBrowser = useCallback(() => {
    const SR = browserSpeech();
    if (!SR) return false;
    const recognition = new SR();
    recognition.continuous = options?.continuous ?? false;
    recognition.interimResults = false;
    recognition.lang = options?.lang ?? "en-AU";
    recognition.onresult = (event: any) => {
      const transcript = event.results[event.results.length - 1][0].transcript;
      onResultRef.current(transcript);
    };
    recognition.onend = () => { setIsListening(false); recognitionRef.current = null; };
    recognition.onerror = (event: any) => {
      console.warn("Speech recognition error:", event.error);
      setIsListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    recognition.start();
    setMode("browser");
    setIsListening(true);
    return true;
  }, [options?.continuous, options?.lang]);

  const upload = useCallback(async (blob: Blob) => {
    setIsTranscribing(true);
    try {
      const r = await fetch(`${API_BASE}/api/dictation/transcribe`, {
        method: "POST",
        headers: { "Content-Type": (blob.type || "audio/webm").split(";")[0] },
        body: blob,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const text = String(j?.text || "").trim();
      if (text) onResultRef.current(text);
      else notify({ kind: "error", message: "No speech was picked up. Try again a little closer to the microphone." });
    } catch (e) {
      console.warn("Dictation upload failed:", e);
      browserOnlyUntil = Date.now() + 5 * 60 * 1000;
      notify({
        kind: "fallback",
        message: browserSpeech()
          ? "That recording couldn't be transcribed. Tap the microphone again to dictate — it will use the browser's dictation for now, without the word library."
          : "That recording couldn't be transcribed. Check your connection and try again.",
      });
    } finally {
      setIsTranscribing(false);
    }
  }, []);

  const startRecording = useCallback(async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.warn("Microphone unavailable for recording:", e);
      return startBrowser();
    }
    const mimeType = pickMimeType();
    const MR = (window as any).MediaRecorder;
    const rec = mimeType ? new MR(stream, { mimeType }) : new MR(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (ev: any) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    rec.onstop = () => {
      clearTimeout(timerRef.current);
      stream.getTracks().forEach((t) => t.stop());
      recorderRef.current = null;
      setIsListening(false);
      const blob = new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" });
      if (blob.size > 0) upload(blob);
    };
    recorderRef.current = rec;
    rec.start();
    setMode("library");
    setIsListening(true);
    timerRef.current = setTimeout(() => { try { if (rec.state === "recording") rec.stop(); } catch {} }, MAX_RECORDING_MS);
    return true;
  }, [startBrowser, upload]);

  const startListening = useCallback(() => {
    if (!isSupported || isTranscribing) return;
    const useLibrary = canRecord() && libraryAvailable === true && Date.now() > browserOnlyUntil;
    if (useLibrary) startRecording();
    else if (!startBrowser() && canRecord() && libraryAvailable) startRecording();
  }, [isSupported, isTranscribing, startBrowser, startRecording]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) { try { recognitionRef.current.stop(); } catch {} recognitionRef.current = null; setIsListening(false); }
    if (recorderRef.current && recorderRef.current.state === "recording") recorderRef.current.stop();
  }, []);

  const toggleListening = useCallback(() => {
    if (isListening) stopListening();
    else startListening();
  }, [isListening, startListening, stopListening]);

  return { isListening, isTranscribing, isSupported, mode, startListening, stopListening, toggleListening };
}
