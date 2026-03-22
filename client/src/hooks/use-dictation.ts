import { useState, useCallback, useRef } from "react";

// Web Speech API types
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

/**
 * Hook for speech-to-text dictation using Web Speech API.
 * Works in Safari iOS and Chrome desktop.
 */
export function useDictation(
  onResult: (text: string) => void,
  options?: { continuous?: boolean; lang?: string }
) {
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);

  const isSupported =
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  const startListening = useCallback(() => {
    if (!isSupported) return;

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    const recognition = new SpeechRecognition();
    recognition.continuous = options?.continuous ?? false;
    recognition.interimResults = false;
    recognition.lang = options?.lang ?? "en-AU";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[event.results.length - 1][0].transcript;
      onResult(transcript);
    };

    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.warn("Speech recognition error:", event.error);
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [isSupported, onResult, options?.continuous, options?.lang]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, []);

  const toggleListening = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  return { isListening, isSupported, startListening, stopListening, toggleListening };
}
