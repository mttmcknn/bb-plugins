// One live screen session: a WebSocket from the panel bound to one emulator.
//
// Frames: the emulator's screenshot stream, scaled to the panel and sent as
// binary messages (12-byte header + PNG). The client acks each frame it
// draws. Up to FRAME_CREDITS frames are in flight, so decode overlaps the next
// frame's transfer, and a slow client gets the latest frame, not a backlog.
//
// Input: JSON text messages. Pointer positions arrive normalized to the
// displayed image; this module maps them to the device's natural (portrait)
// coordinates, which is what the emulator expects regardless of rotation.
import type * as grpc from "@grpc/grpc-js";
import type { ExperimentalPluginWebSocket } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  callUnary,
  type EmulatorClients,
  type RunningEmulator,
} from "./emulators";

const ROTATIONS = ["PORTRAIT", "LANDSCAPE", "REVERSE_PORTRAIT", "REVERSE_LANDSCAPE"];
/** Emulator ROTATION sensor z angle for each rotation index. */
const ROTATION_ANGLES = [0, 90, 180, -90];
const MAX_FRAME_EDGE = 2048;
const TOUCH_PRESSURE = 1024;
const FRAME_CREDITS = 2;
const WHEEL_TOUCH_ID = 9;
const WHEEL_RELEASE_MS = 150;

const point = { x: z.number().min(0).max(1), y: z.number().min(0).max(1) };
const clientMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("size"), w: z.number().int().min(16), h: z.number().int().min(16) }),
  z.object({ t: z.literal("ack") }),
  z.object({ t: z.literal("pause") }),
  z.object({ t: z.literal("touch"), ...point, down: z.boolean(), pinch: z.boolean().optional() }),
  z.object({ t: z.literal("mouse"), ...point, buttons: z.number().int().min(0).max(7) }),
  z.object({ t: z.literal("wheel"), ...point, dx: z.number(), dy: z.number() }),
  z.object({ t: z.literal("key"), key: z.string().min(1).max(32), type: z.enum(["down", "up", "press"]) }),
  z.object({ t: z.literal("text"), text: z.string().min(1).max(4000) }),
  z.object({ t: z.literal("rotate"), dir: z.enum(["left", "right"]) }),
]);
type ClientMessage = z.infer<typeof clientMessage>;

interface ImageMessage {
  image: Buffer;
  format: {
    width: number;
    height: number;
    rotation?: { rotation?: string };
    foldedDisplay?: { width: number; height: number; xOffset: number; yOffset: number };
  };
}

interface DisplayRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class ScreenSession {
  private screenStream: grpc.ClientReadableStream<ImageMessage> | null = null;
  private inputStream: grpc.ClientWritableStream<object> | null = null;
  private inFlight = 0;
  private size: { w: number; h: number } | null = null;
  private pinching = false;
  private wheel: { x: number; y: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
  private pending: ImageMessage | null = null;
  private rotation = 0;
  private region: DisplayRegion;
  private readonly natural: { width: number; height: number };
  private closed = false;

  constructor(
    private readonly socket: ExperimentalPluginWebSocket,
    private readonly emulator: RunningEmulator,
    private readonly clients: EmulatorClients,
    display: { width: number; height: number },
    private readonly log: (message: string) => void,
  ) {
    this.natural = display;
    this.region = { x: 0, y: 0, ...display };
  }

  handle(raw: string | Uint8Array): void {
    if (typeof raw !== "string") return;
    let message: ClientMessage;
    try {
      message = clientMessage.parse(JSON.parse(raw));
    } catch {
      return;
    }
    switch (message.t) {
      case "size":
        // Resizes can repeat the same size; restarting the stream is costly.
        if (this.screenStream && this.size?.w === message.w && this.size.h === message.h) return;
        this.size = { w: message.w, h: message.h };
        this.startScreen(message.w, message.h);
        return;
      case "pause":
        // Hidden panel: stop encoding frames. The next "size" resumes.
        this.screenStream?.cancel();
        this.screenStream = null;
        this.pending = null;
        this.inFlight = 0;
        return;
      case "ack":
        this.inFlight = Math.max(0, this.inFlight - 1);
        if (this.pending) this.sendFrame(this.pending);
        return;
      case "touch":
        this.sendTouch(message.x, message.y, message.down, message.pinch ?? false);
        return;
      case "mouse": {
        const { x, y } = this.toDevice(message.x, message.y);
        this.input({ mouse_event: { x, y, buttons: message.buttons } });
        return;
      }
      case "wheel":
        this.scroll(message.x, message.y, message.dx, message.dy);
        return;
      case "key": {
        const eventType = { down: "keydown", up: "keyup", press: "keypress" }[message.type];
        this.input({ key_event: { eventType, key: message.key } });
        return;
      }
      case "text":
        this.input({ key_event: { text: message.text } });
        return;
      case "rotate":
        this.rotate(message.dir);
        return;
    }
  }

  private startScreen(width: number, height: number): void {
    this.screenStream?.cancel();
    this.pending = null;
    this.inFlight = 0;
    const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(width, height));
    const stream = (this.clients.controller as unknown as {
      streamScreenshot(request: object, metadata: grpc.Metadata): grpc.ClientReadableStream<ImageMessage>;
    }).streamScreenshot(
      { format: "PNG", width: Math.round(width * scale), height: Math.round(height * scale) },
      this.clients.metadata,
    );
    this.screenStream = stream;
    stream.on("data", (image: ImageMessage) => {
      if (stream !== this.screenStream) return;
      if (!image.format.width || !image.format.height) return;
      this.trackGeometry(image);
      if (this.inFlight >= FRAME_CREDITS) this.pending = image;
      else this.sendFrame(image);
    });
    stream.on("error", (error: grpc.ServiceError) => {
      if (stream !== this.screenStream || this.closed || error.code === 1) return;
      this.log(`screen stream for ${this.emulator.avdId} ended: ${error.details || error.message}`);
      this.socket.send(JSON.stringify({ t: "error", message: error.details || error.message }));
      this.socket.close(1011, "Emulator screen stream ended");
    });
  }

  private trackGeometry(image: ImageMessage): void {
    const name = image.format.rotation?.rotation ?? "PORTRAIT";
    this.rotation = Math.max(0, ROTATIONS.indexOf(name));
    const folded = image.format.foldedDisplay;
    this.region =
      folded && folded.width > 0 && folded.height > 0
        ? { x: folded.xOffset, y: folded.yOffset, width: folded.width, height: folded.height }
        : { x: 0, y: 0, ...this.natural };
  }

  private sendFrame(image: ImageMessage): void {
    this.pending = null;
    this.inFlight += 1;
    const frame = new Uint8Array(12 + image.image.length);
    const header = new DataView(frame.buffer);
    header.setUint32(0, image.format.width, true);
    header.setUint32(4, image.format.height, true);
    header.setUint32(8, this.rotation, true);
    frame.set(image.image, 12);
    this.socket.send(frame);
  }

  /** Maps a point on the displayed (rotated) image to device coordinates. */
  private toDevice(nx: number, ny: number): { x: number; y: number } {
    const [u, v] = [
      [nx, ny],
      [1 - ny, nx],
      [1 - nx, 1 - ny],
      [ny, 1 - nx],
    ][this.rotation]!;
    const { x, y, width, height } = this.region;
    return {
      x: Math.round(x + Math.min(width - 1, u * width)),
      y: Math.round(y + Math.min(height - 1, v * height)),
    };
  }

  private sendTouch(nx: number, ny: number, down: boolean, pinch: boolean): void {
    const pressure = down ? TOUCH_PRESSURE : 0;
    const touches = [{ ...this.toDevice(nx, ny), identifier: 0, pressure, expiration: "NEVER_EXPIRE" }];
    // Pinch: a second finger mirrored through the screen center. Lift it when
    // the modifier is released mid-gesture.
    if (pinch || this.pinching) {
      touches.push({
        ...this.toDevice(1 - nx, 1 - ny),
        identifier: 1,
        pressure: pinch ? pressure : 0,
        expiration: "NEVER_EXPIRE",
      });
    }
    this.pinching = pinch && down;
    this.input({ touch_event: { touches } });
  }

  /**
   * Scrolls with a synthetic one-finger drag: wheel events do not scroll on
   * current system images. The finger lifts after a pause, so nothing flings.
   * `dx`/`dy` are wheel notches in the direction the finger should move.
   */
  private scroll(nx: number, ny: number, dx: number, dy: number): void {
    const step = Math.round(Math.max(this.region.width, this.region.height) / 40);
    const clamp = (value: number, max: number) => Math.min(max - 1, Math.max(0, value));
    const [ux, uy] = [
      [dx, dy],
      [-dy, dx],
      [-dx, -dy],
      [dy, -dx],
    ][this.rotation]!;
    if (!this.wheel) this.wheel = { ...this.toDevice(nx, ny), timer: null };
    const wheel = this.wheel;
    const touch = (pressure: number) =>
      this.input({
        touch_event: {
          touches: [{ x: wheel.x, y: wheel.y, identifier: WHEEL_TOUCH_ID, pressure, expiration: "NEVER_EXPIRE" }],
        },
      });
    if (wheel.timer === null) touch(TOUCH_PRESSURE);
    else clearTimeout(wheel.timer);
    wheel.x = clamp(wheel.x + ux * step, this.region.x + this.region.width);
    wheel.y = clamp(wheel.y + uy * step, this.region.y + this.region.height);
    touch(TOUCH_PRESSURE);
    wheel.timer = setTimeout(() => {
      touch(0);
      this.wheel = null;
    }, WHEEL_RELEASE_MS);
  }

  private rotate(dir: "left" | "right"): void {
    const next = (this.rotation + (dir === "left" ? 1 : 3)) % 4;
    callUnary(this.clients, "controller", "setPhysicalModel", {
      target: "ROTATION",
      value: { data: [0, 0, ROTATION_ANGLES[next]] },
    }).catch((error: Error) => this.log(`rotate failed: ${error.message}`));
  }

  private input(event: object): void {
    if (this.closed) return;
    if (!this.inputStream) {
      const stream = (this.clients.controller as unknown as {
        streamInputEvent(metadata: grpc.Metadata, callback: (error: grpc.ServiceError | null) => void): grpc.ClientWritableStream<object>;
      }).streamInputEvent(this.clients.metadata, (error) => {
        if (this.inputStream === stream) this.inputStream = null;
        if (error && error.code !== 1 && !this.closed) {
          this.log(`input stream for ${this.emulator.avdId} ended: ${error.details || error.message}`);
        }
      });
      this.inputStream = stream;
    }
    this.inputStream.write(event);
  }

  close(): void {
    if (this.wheel?.timer) clearTimeout(this.wheel.timer);
    this.wheel = null;
    this.closed = true;
    this.screenStream?.cancel();
    this.screenStream = null;
    this.inputStream?.end();
    this.inputStream = null;
  }
}
