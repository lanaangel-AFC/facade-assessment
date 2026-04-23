import { useEffect, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Check } from "lucide-react";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

type Props = {
  photoId: number;
  initial: string;
  disabled?: boolean;
  onSaved?: (caption: string) => void;
};

type Status = "idle" | "saving" | "saved";

export function PhotoCaptionInput({ photoId, initial, disabled, onSaved }: Props) {
  const [value, setValue] = useState(initial || "");
  const [status, setStatus] = useState<Status>("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>(initial || "");
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setValue(initial || "");
    lastSavedRef.current = initial || "";
  }, [photoId, initial]);

  const save = async (caption: string) => {
    if (caption === lastSavedRef.current) return;
    setStatus("saving");
    try {
      const res = await fetch(`${API_BASE}/api/photos/${photoId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caption }),
      });
      if (!res.ok) throw new Error("failed");
      lastSavedRef.current = caption;
      setStatus("saved");
      onSaved?.(caption);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setStatus("idle"), 1500);
    } catch {
      setStatus("idle");
    }
  };

  const scheduleSave = (next: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => save(next), 700);
  };

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  return (
    <div className="relative">
      <Textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          scheduleSave(e.target.value);
        }}
        onBlur={() => {
          if (debounceRef.current) clearTimeout(debounceRef.current);
          save(value);
        }}
        disabled={disabled}
        placeholder="Caption (what the AI should know about this photo)"
        rows={2}
        className="text-xs resize-none pr-6"
      />
      <div className="absolute right-1 top-1 text-muted-foreground">
        {status === "saving" && <Loader2 className="w-3 h-3 animate-spin" />}
        {status === "saved" && <Check className="w-3 h-3 text-green-600" />}
      </div>
    </div>
  );
}
