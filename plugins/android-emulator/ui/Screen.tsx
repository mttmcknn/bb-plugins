// The live device screen: draws frames from the /screen socket onto a canvas
// and forwards pointer, wheel, and keyboard input back to the emulator.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorMessage, socketUrl, upload } from "./common";
import { Glyph } from "./icons";

export type ScreenMessage =
  | { t: "touch"; x: number; y: number; down: boolean; pinch?: boolean }
  | { t: "mouse"; x: number; y: number; buttons: number }
  | { t: "wheel"; x: number; y: number; dx: number; dy: number }
  | { t: "key"; key: string; type: "down" | "up" | "press" }
  | { t: "text"; text: string }
  | { t: "rotate"; dir: "left" | "right" }
  | { t: "pause" };

export type SendToScreen = (message: ScreenMessage) => void;

type Connection = "connecting" | "live" | "closed";

/** Keys the emulator understands by W3C name that we forward as down/up pairs. */
const SPECIAL_KEYS = new Set([
  "Backspace", "Delete", "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown",
  "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Insert",
]);
const PRINTABLE_ASCII = /^[\x20-\x7e\n\t]*$/;
/** Pixels of trackpad/mouse wheel travel per emulator wheel notch. */
const WHEEL_PIXELS_PER_NOTCH = 40;
const MAX_AUTO_RETRIES = 3;
/** A translucent fingertip, so touch mode reads as touch rather than a mouse. */
const FINGER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><circle cx="14" cy="14" r="12" fill="rgba(128,128,128,0.35)" stroke="white" stroke-opacity="0.9" stroke-width="1.5"/></svg>',
)}") 14 14, pointer`;

const CORNER_OVERSCAN = 1.1;

type Frame = { w: number; h: number; rotation: number };
/** Device corner radii (natural orientation, device pixels) and the natural width. */
type DisplayInfo = { corners: [number, number, number, number]; width: number };

/**
 * CSS clip path for the displayed frame. Rotating the device moves each
 * natural corner to a new on-screen corner, and the frame is scaled.
 */
function cornerClip(info: DisplayInfo | null, frame: Frame, cssWidth: number, cssHeight: number): string | undefined {
  if (!info) return undefined;
  // The on-screen edge that shows the device's natural width.
  const scale = (frame.rotation % 2 === 0 ? cssWidth : cssHeight) / info.width;
  // Natural [TL, TR, BR, BL] -> on-screen [TL, TR, BR, BL] for each rotation.
  const order = [
    [0, 1, 2, 3],
    [1, 2, 3, 0],
    [2, 3, 0, 1],
    [3, 0, 1, 2],
  ][frame.rotation] ?? [0, 1, 2, 3];
  // SystemUI's corner overlay is a smoother curve than a circular arc and is
  // anti-aliased. A 1px inset with slightly larger radii hides its dark edge.
  const radii = order.map((index) => `${(info.corners[index]! * scale * CORNER_OVERSCAN).toFixed(2)}px`);
  return `inset(1px round ${radii.join(" ")})`;
}

export function Screen({
  avdId,
  mouseMode,
  onSendReady,
  onPasteNonAscii,
}: {
  avdId: string;
  /** Send mouse events (hover, right click) instead of touches. */
  mouseMode: boolean;
  onSendReady: (send: SendToScreen | null) => void;
  onPasteNonAscii: (text: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const pointerDown = useRef(false);
  const wheelRemainder = useRef({ x: 0, y: 0 });
  const pendingMove = useRef<ScreenMessage | null>(null);
  const [frameSize, setFrameSize] = useState<Frame | null>(null);
  const [displayInfo, setDisplayInfo] = useState<DisplayInfo | null>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** Automatic reconnects since the last live frame (plugin reloads drop the socket). */
  const retries = useRef(0);
  const [dragging, setDragging] = useState(false);

  const send = useCallback<SendToScreen>((message) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  /** Pointer moves fire faster than frames; send at most one per animation frame. */
  const sendMove = useCallback(
    (message: ScreenMessage) => {
      const first = pendingMove.current === null;
      pendingMove.current = message;
      if (!first) return;
      requestAnimationFrame(() => {
        const latest = pendingMove.current;
        pendingMove.current = null;
        if (latest) send(latest);
      });
    },
    [send],
  );

  /** Presses and releases flush any queued move first, so order is kept. */
  const sendNow = useCallback(
    (message: ScreenMessage) => {
      const queued = pendingMove.current;
      pendingMove.current = null;
      if (queued) send(queued);
      send(message);
    },
    [send],
  );

  // Track the available area so frames are requested at display resolution.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setBox({ w: Math.floor(entry.contentRect.width), h: Math.floor(entry.contentRect.height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setConnection("connecting");
    setError(null);
    setFrameSize(null);
    setDisplayInfo(null);
    const socket = new WebSocket(socketUrl("/screen", { avd: avdId }));
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    let disposed = false;
    let serverError = false;
    // Opaque and desynchronized: the browser can skip compositing work.
    let context: CanvasRenderingContext2D | null = null;
    // Two frames can decode at once; never draw an older one over a newer one.
    let received = 0;
    let drawn = 0;
    socket.onopen = () => {
      onSendReady(send);
    };
    socket.onmessage = async (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data) as { t: string; message?: string } & Partial<DisplayInfo>;
        if (message.t === "error") {
          serverError = true;
          setError(message.message ?? "The emulator stopped responding.");
        }
        if (message.t === "display" && message.corners && message.width) {
          setDisplayInfo({ corners: message.corners, width: message.width });
        }
        return;
      }
      const buffer = event.data as ArrayBuffer;
      const header = new DataView(buffer, 0, 12);
      const w = header.getUint32(0, true);
      const h = header.getUint32(4, true);
      const rotation = header.getUint32(8, true);
      const sequence = ++received;
      try {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(buffer, 12)], { type: "image/png" }));
        const canvas = canvasRef.current;
        if (!disposed && canvas && sequence > drawn) {
          drawn = sequence;
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
          }
          context ??= canvas.getContext("2d", { alpha: false, desynchronized: true });
          context?.drawImage(bitmap, 0, 0);
          setFrameSize((current) =>
            current?.w === w && current.h === h && current.rotation === rotation ? current : { w, h, rotation },
          );
          setConnection("live");
          retries.current = 0;
        }
        bitmap.close();
      } finally {
        if (!disposed) socket.send(JSON.stringify({ t: "ack" }));
      }
    };
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    socket.onclose = () => {
      if (disposed) return;
      onSendReady(null);
      // Retry quietly unless the server reported a real error.
      if (!serverError && retries.current < MAX_AUTO_RETRIES) {
        const delay = 500 * 2 ** retries.current;
        retries.current += 1;
        retryTimer = setTimeout(() => setAttempt((value) => value + 1), delay);
        return;
      }
      setConnection("closed");
    };
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      onSendReady(null);
      socket.close();
      socketRef.current = null;
    };
  }, [avdId, attempt, onSendReady, send]);

  // Stop frame encoding while BB is hidden; the size effect resumes it.
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const onChange = () => {
      setHidden(document.hidden);
      if (document.hidden) send({ t: "pause" });
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [send]);

  // (Re)request frames sized to the panel whenever it resizes.
  useEffect(() => {
    if (box.w < 16 || box.h < 16 || hidden) return;
    const ratio = window.devicePixelRatio || 1;
    const size = { t: "size", w: Math.round(box.w * ratio), h: Math.round(box.h * ratio) };
    const socket = socketRef.current;
    if (!socket) return;
    const timer = setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(size));
      else socket.addEventListener("open", () => socket.send(JSON.stringify(size)), { once: true });
    }, 120);
    return () => clearTimeout(timer);
  }, [box, attempt, avdId, hidden]);

  const offline = connection !== "live" || error !== null;

  // Fit the frame inside the available area, preserving aspect ratio.
  const display = frameSize
    ? (() => {
        const scale = Math.min(box.w / frameSize.w, box.h / frameSize.h);
        return { width: Math.floor(frameSize.w * scale), height: Math.floor(frameSize.h * scale) };
      })()
    : null;

  function position(event: { clientX: number; clientY: number }) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }

  function mouseButtons(buttons: number) {
    // DOM: 1 primary, 2 secondary, 4 middle. Emulator: 1 left, 2 right, 4 middle.
    return buttons & 7;
  }

  function onPointerDown(event: PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDown.current = true;
    const point = position(event);
    if (mouseMode) sendNow({ t: "mouse", ...point, buttons: mouseButtons(event.buttons) });
    else sendNow({ t: "touch", ...point, down: true, pinch: event.altKey });
  }

  function onPointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const point = position(event);
    if (mouseMode) sendMove({ t: "mouse", ...point, buttons: mouseButtons(event.buttons) });
    else if (pointerDown.current) sendMove({ t: "touch", ...point, down: true, pinch: event.altKey });
  }

  function onPointerUp(event: PointerEvent<HTMLCanvasElement>) {
    if (!pointerDown.current) return;
    pointerDown.current = false;
    const point = position(event);
    if (mouseMode) sendNow({ t: "mouse", ...point, buttons: mouseButtons(event.buttons) });
    else sendNow({ t: "touch", ...point, down: false, pinch: event.altKey });
  }

  function onWheel(event: WheelEvent<HTMLCanvasElement>) {
    const scale = event.deltaMode === 1 ? WHEEL_PIXELS_PER_NOTCH : event.deltaMode === 2 ? 400 : 1;
    const remainder = wheelRemainder.current;
    remainder.x += event.deltaX * scale;
    remainder.y += event.deltaY * scale;
    const dx = Math.trunc(remainder.x / WHEEL_PIXELS_PER_NOTCH);
    const dy = Math.trunc(remainder.y / WHEEL_PIXELS_PER_NOTCH);
    if (dx === 0 && dy === 0) return;
    remainder.x -= dx * WHEEL_PIXELS_PER_NOTCH;
    remainder.y -= dy * WHEEL_PIXELS_PER_NOTCH;
    send({ t: "wheel", ...position(event), dx: -dx, dy: -dy });
  }

  function onKeyDown(event: KeyboardEvent<HTMLCanvasElement>) {
    // Leave app shortcuts (and Cmd/Ctrl+V, handled by onPaste) to the host.
    if (event.metaKey || event.ctrlKey) return;
    if (event.key.length === 1) {
      send({ t: "key", key: event.key, type: "press" });
    } else if (SPECIAL_KEYS.has(event.key)) {
      send({ t: "key", key: event.key, type: "down" });
    } else {
      return;
    }
    event.preventDefault();
  }

  function onKeyUp(event: KeyboardEvent<HTMLCanvasElement>) {
    if (event.metaKey || event.ctrlKey || !SPECIAL_KEYS.has(event.key)) return;
    send({ t: "key", key: event.key, type: "up" });
    event.preventDefault();
  }

  function onPaste(event: ClipboardEvent<HTMLCanvasElement>) {
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    if (PRINTABLE_ASCII.test(text) && text.length <= 4000) send({ t: "text", text });
    else onPasteNonAscii(text);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    for (const file of Array.from(event.dataTransfer.files)) {
      const pending = toast.loading(`Sending ${file.name}…`);
      upload(avdId, file).then(
        (message) => toast.success(message, { id: pending }),
        (error: unknown) => toast.error(errorMessage(error), { id: pending }),
      );
    }
  }

  return (
    <div
      ref={containerRef}
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        aria-label={`${avdId} screen. Click to interact, type to send keys. Hold Option to pinch.`}
        className={cn(
          "touch-none select-none outline-none ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring",
          display === null && "invisible",
          // Frozen last frame: blur and dim it so the status card reads clearly.
          "transition-[filter] duration-200",
          offline && "pointer-events-none blur-sm brightness-50 saturate-50",
        )}
        style={
          display && frameSize
            ? {
                ...display,
                clipPath: cornerClip(displayInfo, frameSize, display.width, display.height),
                cursor: mouseMode ? "default" : FINGER_CURSOR,
              }
            : { width: 0, height: 0 }
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(event) => event.preventDefault()}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPaste={onPaste}
      />
      {offline ? (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div
            role="status"
            className="flex max-w-64 flex-col items-center gap-3 rounded-xl border border-border bg-background px-5 py-4 text-center text-sm shadow-lg"
          >
            {error || connection === "closed" ? (
              <>
                <p className="text-foreground">{error ?? "Disconnected from the emulator."}</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    retries.current = 0;
                    setAttempt((value) => value + 1);
                  }}
                >
                  <Glyph name="refresh" /> Reconnect
                </Button>
              </>
            ) : (
              <>
                <Glyph name="loading" className="size-5 text-muted-foreground" />
                <p className="text-muted-foreground">
                  {retries.current > 0 ? "Reconnecting" : "Connecting"} to {avdId}…
                </p>
              </>
            )}
          </div>
        </div>
      ) : null}
      {dragging ? (
        <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-xl border-2 border-dashed border-ring bg-background/70 text-sm text-foreground">
          Drop an APK to install it, or any file to copy it to /sdcard/Download
        </div>
      ) : null}
    </div>
  );
}
