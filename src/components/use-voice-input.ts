"use client";

import { useEffect, useRef, useState } from "react";
import { VOICE_MAX_BYTES, VOICE_MAX_SECONDS, VOICE_MIME_TYPES } from "@/lib/domain/voice";

type Phase = "idle" | "requesting" | "recording" | "transcribing";

export function useVoiceInput(accountId: string, onTranscript: (text: string) => void) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [canRetry, setCanRetry] = useState(false);
  const callback = useRef(onTranscript);
  const session = useRef(0);
  const active = useRef(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const permissionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const recording = useRef<Blob | null>(null);

  useEffect(() => { callback.current = onTranscript; }, [onTranscript]);

  function releaseMicrophone() {
    if (timer.current) clearInterval(timer.current);
    if (permissionTimer.current) clearTimeout(permissionTimer.current);
    timer.current = null;
    permissionTimer.current = null;
    if (recorder.current) {
      recorder.current.onstop = null;
      recorder.current.ondataavailable = null;
      recorder.current.onerror = null;
      if (recorder.current.state !== "inactive") recorder.current.stop();
      recorder.current = null;
    }
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }

  function cancel() {
    session.current++;
    active.current = false;
    controller.current?.abort();
    releaseMicrophone();
    recording.current = null;
    setPhase("idle");
    setCanRetry(false);
    setError("");
    setStatus("Recording discarded.");
  }

  useEffect(() => {
    function leave() {
      session.current++;
      active.current = false;
      controller.current?.abort();
      releaseMicrophone();
      recording.current = null;
    }
    function pageHide() {
      leave();
      setPhase("idle");
      setCanRetry(false);
      setStatus("");
      setError("");
    }
    window.addEventListener("pagehide", pageHide);
    return () => {
      window.removeEventListener("pagehide", pageHide);
      leave();
    };
  }, [accountId]);

  async function transcribe(blob: Blob, attempt: number) {
    setPhase("transcribing");
    setStatus("Transcribing your recording…");
    setError("");
    setCanRetry(false);
    const abort = new AbortController();
    controller.current = abort;
    try {
      const response = await fetch("/api/onboarding/transcribe", {
        method: "POST",
        headers: { "Content-Type": blob.type, "X-Sidekick-Account": accountId },
        body: blob,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
      });
      const result = await response.json();
      if (session.current !== attempt) return;
      if (!response.ok) throw new Error(result.message || "Could not transcribe the recording. Try again.");
      if (typeof result.text !== "string" || !result.text.trim()) throw new Error("No speech was detected. Record again or type your message.");
      callback.current(result.text.trim());
      recording.current = null;
      setStatus("Transcript added. Review it before sending.");
    } catch (failure) {
      if (session.current !== attempt) return;
      setStatus("");
      setError(failure instanceof Error && !["AbortError", "TimeoutError"].includes(failure.name)
        ? failure.message
        : "Transcription timed out. Retry or type your message.");
      setCanRetry(true);
    } finally {
      if (session.current === attempt) {
        active.current = false;
        setPhase("idle");
      }
    }
  }

  async function start() {
    if (active.current) return;
    setError("");
    setStatus("");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Voice recording is unavailable here. Use a supported browser over HTTPS, or type your message.");
      return;
    }
    const mimeType = VOICE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      setError("This browser cannot record a supported audio format. Try another browser or type your message.");
      return;
    }
    const attempt = ++session.current;
    active.current = true;
    recording.current = null;
    setCanRetry(false);
    setSeconds(0);
    setPhase("requesting");
    setStatus("Allow microphone access to start recording.");
    permissionTimer.current = setTimeout(() => {
      if (session.current !== attempt) return;
      cancel();
      setStatus("");
      setError("Microphone access is still pending. Try again when you are ready, or type your message.");
    }, 20000);
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (session.current !== attempt) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      if (permissionTimer.current) clearTimeout(permissionTimer.current);
      stream.current = media;
      const capture = new MediaRecorder(media, { mimeType, audioBitsPerSecond: 64000 });
      recorder.current = capture;
      const chunks: Blob[] = [];
      let bytes = 0;
      capture.ondataavailable = (event) => {
        bytes += event.data.size;
        if (bytes > VOICE_MAX_BYTES) {
          cancel();
          setStatus("");
          setError("The recording is too large. Try a shorter recording.");
          return;
        }
        if (event.data.size) chunks.push(event.data);
      };
      capture.onerror = () => {
        cancel();
        setStatus("");
        setError("Recording stopped unexpectedly. Try again or type your message.");
      };
      capture.onstop = () => {
        if (session.current !== attempt) return;
        const blob = new Blob(chunks, { type: capture.mimeType });
        releaseMicrophone();
        if (!blob.size) {
          active.current = false;
          setPhase("idle");
          setStatus("");
          setError("No audio was recorded. Try again.");
          return;
        }
        recording.current = blob;
        void transcribe(blob, attempt);
      };
      capture.start(1000);
      setPhase("recording");
      setStatus("Recording. Stop when you are ready to transcribe.");
      const started = Date.now();
      timer.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - started) / 1000);
        setSeconds(Math.min(elapsed, VOICE_MAX_SECONDS));
        if (elapsed >= VOICE_MAX_SECONDS && capture.state === "recording") capture.stop();
      }, 250);
    } catch (failure) {
      if (session.current !== attempt) return;
      releaseMicrophone();
      active.current = false;
      setPhase("idle");
      setStatus("");
      setError(failure instanceof DOMException && failure.name === "NotAllowedError"
        ? "Microphone access was denied. Allow it in your browser settings and try again, or type your message."
        : "Could not access your microphone. Check that it is connected and try again, or type your message.");
    }
  }

  return {
    phase, seconds, error, status, canRetry,
    busy: phase !== "idle",
    start,
    stop: () => { if (recorder.current?.state === "recording") recorder.current.stop(); },
    cancel,
    reset: () => { cancel(); setStatus(""); },
    retry: () => {
      if (active.current || !recording.current) return;
      active.current = true;
      void transcribe(recording.current, ++session.current);
    },
  };
}
