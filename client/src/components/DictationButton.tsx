// AFC dictation button (shared kit — keep identical across apps).
// Source of truth: github.com/lanaangel-AFC/afc-word-library/kit. Copy, don't edit locally.
import { Mic, MicOff, Loader2, BookPlus } from "lucide-react";
import { useDictation, type DictationNotice } from "@/hooks/use-dictation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
const ADD_WORD_VISIBLE_MS = 20000;

interface DictationButtonProps {
  /** Called with transcript text to append to the field */
  onTranscript: (text: string) => void;
  className?: string;
}

/**
 * Microphone button. Tap to start, tap again to stop. Speech is transcribed with the
 * shared AFC word library; if that's unavailable it falls back to browser dictation.
 * After a word-library dictation, a small "add a word" button appears for 20 seconds.
 */
export function DictationButton({ onTranscript, className }: DictationButtonProps) {
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [heard, setHeard] = useState("");
  const [saving, setSaving] = useState(false);
  const [editUrl, setEditUrl] = useState<string | null>(null);
  const hideTimer = useRef<any>(null);
  const modeRef = useRef<string | null>(null);

  const handleNotice = useCallback((n: DictationNotice) => {
    toast({ title: n.kind === "fallback" ? "Dictation" : "Nothing heard", description: n.message, variant: n.kind === "fallback" ? "destructive" : undefined });
  }, [toast]);

  const handleResult = useCallback((text: string) => {
    onTranscript(text);
    if (modeRef.current === "library") {
      setShowAdd(true);
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setShowAdd(false), ADD_WORD_VISIBLE_MS);
    }
  }, [onTranscript]);

  const { isListening, isTranscribing, isSupported, mode, toggleListening } = useDictation(handleResult, { onNotice: handleNotice });
  modeRef.current = mode;

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  const openDialog = useCallback(() => {
    clearTimeout(hideTimer.current);
    setTerm(""); setHeard(""); setDialogOpen(true);
    fetch(`${API_BASE}/api/dictation/status`).then((r) => r.json()).then((j) => setEditUrl(j?.library?.editUrl || null)).catch(() => {});
  }, []);

  const save = useCallback(async () => {
    if (!term.trim()) return;
    setSaving(true);
    try {
      const r = await fetch(`${API_BASE}/api/word-library/add`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ term: term.trim(), heard: heard.trim() || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      toast({ title: r.ok ? "Word library" : "Couldn't add the word", description: j?.message || `HTTP ${r.status}`, variant: r.ok ? undefined : "destructive" });
      if (r.ok) { setDialogOpen(false); setShowAdd(false); }
    } catch {
      toast({ title: "Couldn't add the word", description: "Check your connection and try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }, [term, heard, toast]);

  if (!isSupported) return null;

  return (
    <>
      <button
        type="button"
        onClick={toggleListening}
        disabled={isTranscribing}
        className={`p-1.5 rounded-md border transition-colors ${
          isListening
            ? "bg-red-100 border-red-300 text-red-600 dark:bg-red-900/30 dark:border-red-700 dark:text-red-400 animate-pulse"
            : isTranscribing
              ? "bg-background border-border text-muted-foreground cursor-wait"
              : "bg-background border-border text-muted-foreground hover:bg-accent hover:text-foreground"
        } ${className ?? ""}`}
        title={isTranscribing ? "Transcribing…" : isListening ? "Stop dictation" : "Start dictation"}
        aria-label={isTranscribing ? "Transcribing" : isListening ? "Stop dictation" : "Start dictation"}
        data-testid="button-dictate"
        data-dictation-mode={mode ?? ""}
        data-transcribing={isTranscribing ? "true" : "false"}
      >
        {isTranscribing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : isListening ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
      </button>
      {showAdd && !isListening && !isTranscribing && (
        <button
          type="button"
          onClick={openDialog}
          className="ml-1 p-1.5 rounded-md border bg-background border-border text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Add a word to the word library"
          aria-label="Add a word to the word library"
          data-testid="button-add-word"
        >
          <BookPlus className="w-3.5 h-3.5" />
        </button>
      )}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add to the word library</DialogTitle>
            <DialogDescription>
              Dictation in every AFC app will expect this word. This app uses it straight away; the others pick it up within an hour.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="wl-term">Correct word or phrase</Label>
              <Input id="wl-term" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="e.g. sealant" data-testid="input-word-term" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wl-heard">What dictation wrote instead (optional)</Label>
              <Input id="wl-heard" value={heard} onChange={(e) => setHeard(e.target.value)} placeholder="e.g. ceiling" data-testid="input-word-heard" />
            </div>
            {editUrl && (
              <p className="text-xs text-muted-foreground">
                To change or remove words, <a href={editUrl} target="_blank" rel="noreferrer" className="underline">edit the full list on GitHub</a>.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={!term.trim() || saving} data-testid="button-save-word">{saving ? "Adding…" : "Add word"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
