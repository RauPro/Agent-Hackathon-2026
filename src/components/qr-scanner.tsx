"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

type Detector = {
  detect: (image: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
};

export function connectionPath(value: string, origin: string) {
  try {
    const url = new URL(value.trim(), origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return /^\/connect\/[a-zA-Z0-9_-]{20,128}$/.test(url.pathname)
      ? url.pathname
      : null;
  } catch {
    return null;
  }
}

export function QRScanner() {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState("");
  const [link, setLink] = useState("");

  const stop = useCallback(() => {
    generation.current += 1;
    if (timer.current) clearTimeout(timer.current);
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setActive(false);
    setStarting(false);
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      generation.current += 1;
      if (timer.current) clearTimeout(timer.current);
      stream.current?.getTracks().forEach((track) => track.stop());
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [stop]);

  function open(value: string) {
    const path = connectionPath(value, window.location.origin);
    if (!path) {
      setProblem("Use a Sidekick connection code or link from this site.");
      return false;
    }
    stop();
    window.location.assign(path);
    return true;
  }

  async function start() {
    stop();
    setProblem("");
    setStarting(true);
    const current = generation.current;
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      if (current !== generation.current) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      if (!video.current) throw new Error("Camera unavailable");
      video.current.srcObject = media;
      await video.current.play();
      if (current !== generation.current) return;
      setStarting(false);
      setActive(true);
      const native = (
        window as unknown as {
          BarcodeDetector?: new (options: { formats: string[] }) => Detector;
        }
      ).BarcodeDetector;
      let detector: Detector | null = null;
      try {
        if (native) detector = new native({ formats: ["qr_code"] });
      } catch {
        /* Canvas decoding remains available. */
      }
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const scan = async () => {
        if (current !== generation.current || !video.current) return;
        try {
          let value: string | undefined;
          if (detector) {
            try {
              value = (await detector.detect(video.current))[0]?.rawValue;
            } catch {
              detector = null;
            }
          }
          if (!detector && context && video.current.videoWidth) {
            canvas.width = Math.min(video.current.videoWidth, 800);
            canvas.height = Math.round(
              (video.current.videoHeight * canvas.width) /
                video.current.videoWidth,
            );
            context.drawImage(video.current, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            );
            value = jsQR(pixels.data, pixels.width, pixels.height)?.data;
          }
          if (current !== generation.current) return;
          if (value && open(value)) return;
          timer.current = setTimeout(() => void scan(), 350);
        } catch {
          stop();
          setProblem(
            "The camera stopped. Try again or paste a connection link.",
          );
        }
      };
      void scan();
    } catch {
      if (current !== generation.current) return;
      stop();
      setProblem(
        "Camera access is unavailable. Choose a QR image or paste a connection link.",
      );
    }
  }

  async function readImage(file?: File) {
    if (!file) return;
    stop();
    setProblem("");
    if (file.size > 10 * 1024 * 1024) {
      setProblem("Choose an image smaller than 10 MB.");
      return;
    }
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Image unavailable");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const decoded = jsQR(pixels.data, pixels.width, pixels.height);
      if (!decoded)
        setProblem(
          "No QR code found. Try a clearer image or paste the connection link.",
        );
      else open(decoded.data);
    } catch {
      setProblem(
        "Could not read that image. Try another image or paste the connection link.",
      );
    } finally {
      bitmap?.close();
    }
  }

  return (
    <section className="network-scanner" aria-label="Scan a connection code">
      <video
        ref={video}
        muted
        playsInline
        hidden={!active && !starting}
        aria-label="QR camera preview"
      />
      <div className="network-actions">
        <button
          className="secondary-button"
          onClick={() => (active || starting ? stop() : void start())}
        >
          {starting ? "Cancel camera" : active ? "Stop camera" : "Scan QR code"}
        </button>
        <label className="secondary-button network-file">
          Choose QR image
          <input
            type="file"
            accept="image/*"
            onChange={(event) => void readImage(event.target.files?.[0])}
          />
        </label>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          open(link);
        }}
        className="network-inline-form"
      >
        <label htmlFor="connection-link">Connection link</label>
        <input
          id="connection-link"
          type="text"
          inputMode="url"
          autoCapitalize="none"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          required
          placeholder="Paste a Sidekick link"
        />
        <button className="secondary-button" type="submit">
          Open connection
        </button>
      </form>
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
