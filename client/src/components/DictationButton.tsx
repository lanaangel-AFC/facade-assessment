import { Mic, MicOff } from "lucide-react";
import { useDictation } from "@/hooks/use-dictation";
import { useCallback } from "react";

interface DictationButtonProps {
  /** Called with transcript text to append to the field */
  onTranscript: (text: string) => void;
  className?: string;
}

/**
 * Small microphone button that activates speech-to-text dictation.
 * Appends transcribed text to the target field via onTranscript callback.
 */
export function DictationButton({ onTranscript, className }: DictationButtonProps) {
  const handleResult = useCallback(
    (text: string) => {
      onTranscript(text);
    },
    [onTranscript]
  );

  const { isListening, isSupported, toggleListening } = useDictation(handleResult);

  if (!isSupported) return null;

  return (
    <button
      type="button"
      onClick={toggleListening}
      className={`p-1.5 rounded-md border transition-colors ${
        isListening
          ? "bg-red-100 border-red-300 text-red-600 dark:bg-red-900/30 dark:border-red-700 dark:text-red-400 animate-pulse"
          : "bg-background border-border text-muted-foreground hover:bg-accent hover:text-foreground"
      } ${className ?? ""}`}
      title={isListening ? "Stop dictation" : "Start dictation"}
      data-testid="button-dictate"
    >
      {isListening ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
    </button>
  );
}
