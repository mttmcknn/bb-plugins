// bb-plugin-android-emulator — backend entry.
//
// Runs Android emulators headless (the way Android Studio's embedded emulator
// does) and exposes them to the thread side panel:
// - RPC for device management: AVDs, launch/stop, snapshots, device settings.
// - WebSocket `/screen` for the live screen and input (server/session.ts).
// - WebSocket `/upload` for installing APKs and pushing files.
// - GET routes for screenshots, recordings, and files pulled from the device.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  createAvd,
  deleteAvd,
  DEVICE_PROFILES,
  duplicateAvd,
  listAvds,
  listSystemImages,
} from "./server/avds";
import {
  adbShell,
  callUnary,
  EmulatorRegistry,
  launchEmulator,
  listRunning,
  readCornerRadii,
  stopEmulator,
  type CornerRadii,
  type RunningEmulator,
} from "./server/emulators";
import { resolveSdkPaths, run, shellQuote, type SdkPaths } from "./server/sdk";
import { ScreenSession } from "./server/session";

const avdId = z.string().regex(/^[A-Za-z0-9._-]+$/, "Invalid AVD id");
const byAvd = z.object({ avdId }).strict();
const ok = z.object({ ok: z.literal(true) });
const DONE = { ok: true as const };

const deviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  apiLevel: z.string(),
  device: z.string(),
  imageTag: z.string(),
  abi: z.string(),
  screen: z.string(),
  status: z.enum(["stopped", "starting", "booting", "running"]),
  serial: z.string().nullable(),
});
export type Device = z.infer<typeof deviceSchema>;

const deviceSettingsSchema = z.object({
  darkTheme: z.boolean(),
  fontScale: z.number(),
  density: z.number(),
  physicalDensity: z.number(),
  navigation: z.enum(["gestural", "threebutton", "twobutton"]),
  layoutBounds: z.boolean(),
  showTouches: z.boolean(),
});
export type DeviceSettings = z.infer<typeof deviceSettingsSchema>;

const deviceSettingChange = z.discriminatedUnion("key", [
  z.object({ key: z.literal("darkTheme"), value: z.boolean() }),
  z.object({ key: z.literal("fontScale"), value: z.number().min(0.5).max(2.5) }),
  z.object({ key: z.literal("density"), value: z.number().int().min(72).max(1000).nullable() }),
  z.object({ key: z.literal("navigation"), value: z.enum(["gestural", "threebutton"]) }),
  z.object({ key: z.literal("layoutBounds"), value: z.boolean() }),
  z.object({ key: z.literal("showTouches"), value: z.boolean() }),
]);
export type DeviceSettingChange = z.infer<typeof deviceSettingChange>;

const fileEntrySchema = z.object({
  name: z.string(),
  directory: z.boolean(),
  size: z.number(),
  modified: z.string(),
});
export type DeviceFile = z.infer<typeof fileEntrySchema>;

const snapshotSchema = z.object({
  id: z.string(),
  createdAt: z.number().nullable(),
  sizeBytes: z.number().nullable(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const rpcContract = defineRpcContract({
  devices: {
    input: z.null(),
    output: z.object({
      sdkPath: z.string(),
      sdkError: z.string().nullable(),
      devices: z.array(deviceSchema),
    }),
  },
  launch: {
    input: z
      .object({ avdId, coldBoot: z.boolean().optional(), wipeData: z.boolean().optional() })
      .strict(),
    output: ok,
  },
  stop: { input: byAvd, output: ok },
  createOptions: {
    input: z.null(),
    output: z.object({
      profiles: z.array(z.object({ id: z.string(), name: z.string(), screen: z.string() })),
      systemImages: z.array(z.object({ path: z.string(), label: z.string() })),
      devices: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  },
  create: {
    input: z
      .object({
        name: z.string().trim().min(1).max(80),
        profileId: z.string(),
        systemImage: z.string(),
        ramMb: z.number().int().min(1024).max(16384),
        storageGb: z.number().int().min(2).max(256),
      })
      .strict(),
    output: z.object({ avdId: z.string() }),
  },
  duplicate: {
    input: z.object({ avdId, name: z.string().trim().min(1).max(80) }).strict(),
    output: z.object({ avdId: z.string() }),
  },
  remove: { input: byAvd, output: ok },
  snapshots: { input: byAvd, output: z.object({ snapshots: z.array(snapshotSchema) }) },
  snapshotAction: {
    input: z
      .object({
        avdId,
        action: z.enum(["save", "load", "delete"]),
        snapshotId: z.string().regex(/^[\w.-]{1,64}$/, "Use letters, digits, '.', '_' or '-'"),
      })
      .strict(),
    output: ok,
  },
  deviceSettings: { input: byAvd, output: deviceSettingsSchema },
  setDeviceSetting: {
    input: z
      .object({
        avdId,
        setting: deviceSettingChange,
      })
      .strict(),
    output: ok,
  },
  deviceAction: {
    input: z
      .object({
        avdId,
        action: z.enum(["extendedControls", "fold", "unfold", "coldBoot", "wipeData"]),
      })
      .strict(),
    output: ok,
  },
  recording: {
    input: z.object({ avdId, action: z.enum(["start", "stop", "status"]) }).strict(),
    output: z.object({ recording: z.boolean(), downloadId: z.string().nullable() }),
  },
  files: {
    input: z.object({ avdId, path: z.string().min(1).max(1024) }).strict(),
    output: z.object({ path: z.string(), entries: z.array(fileEntrySchema) }),
  },
  pasteText: {
    input: z.object({ avdId, text: z.string().max(100_000) }).strict(),
    output: ok,
  },
});

/** Realtime channel: the device list or a device status changed. */
const DEVICES_CHANGED = "devices-changed";
const RECORDING_TIME_LIMIT_SECONDS = 180;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    sdkPath: {
      type: "string",
      label: "Android SDK path",
      description: "Leave empty to use ANDROID_HOME or ~/Library/Android/sdk.",
      default: "",
    },
    stopOnQuit: {
      type: "boolean",
      label: "Stop emulators when BB quits",
      description: "Applies to emulators started from BB. Emulators started elsewhere keep running.",
      default: true,
    },
  });
  let paths: SdkPaths = resolveSdkPaths((await settings.get()).sdkPath);
  const registry = new EmulatorRegistry(() => paths);
  settings.onChange((next) => {
    paths = resolveSdkPaths(next.sdkPath);
    registry.forget();
    bb.realtime.publish(DEVICES_CHANGED, null);
  });

  const workDir = path.join(os.tmpdir(), "bb-android-emulator");
  const recordings = new Map<string, string>();
  const launching = new Map<string, number>();
  const sessions = new Set<ScreenSession>();
  // Keyed by pid, so a restarted emulator (for example after wipe) rereads.
  const cornerCache = new Map<number, Promise<CornerRadii | null>>();
  function cornerRadii(emulator: RunningEmulator): Promise<CornerRadii | null> {
    let cached = cornerCache.get(emulator.pid);
    if (!cached) {
      cached = readCornerRadii(paths, emulator);
      cached.catch(() => cornerCache.delete(emulator.pid));
      cornerCache.set(emulator.pid, cached);
    }
    return cached;
  }

  function sdkError(): string | null {
    if (!paths.sdk) return "Android SDK not found. Set its path in the plugin settings.";
    if (!existsSync(paths.emulator)) return `No emulator at ${paths.emulator}. Install the Android Emulator SDK package.`;
    return null;
  }

  async function bootStatus(emulator: RunningEmulator): Promise<"booting" | "running"> {
    try {
      const status = await callUnary<{ booted: boolean }>(
        registry.clientsFor(emulator), "controller", "getStatus", {}, 1_500,
      );
      return status.booted ? "running" : "booting";
    } catch {
      return "booting";
    }
  }

  async function listDevices(): Promise<Device[]> {
    const [avds, running] = await Promise.all([listAvds(paths), listRunning(paths)]);
    return Promise.all(
      avds.map(async (avd): Promise<Device> => {
        const emulator = running.find((entry) => entry.avdId === avd.id);
        if (emulator) launching.delete(avd.id);
        const startedAt = launching.get(avd.id);
        const status = emulator
          ? await bootStatus(emulator)
          : startedAt !== undefined && Date.now() - startedAt < 60_000
            ? "starting"
            : "stopped";
        return { ...avd, status, serial: emulator?.serial ?? null };
      }),
    );
  }

  function changed(): void {
    bb.realtime.publish(DEVICES_CHANGED, null);
  }

  async function launch(id: string, options: { coldBoot?: boolean; wipeData?: boolean }) {
    if (await registry.find(id)) throw new Error(`${id} is already running.`);
    await mkdir(workDir, { recursive: true });
    const { stopOnQuit } = await settings.get();
    launchEmulator(paths, id, path.join(workDir, `${id}.log`), {
      ...options,
      ownerPid: stopOnQuit ? process.pid : undefined,
    });
    launching.set(id, Date.now());
    changed();
  }

  async function restart(id: string, options: { coldBoot?: boolean; wipeData?: boolean }) {
    await stopEmulator(registry, paths, id);
    const deadline = Date.now() + 30_000;
    while (await registry.find(id)) {
      if (Date.now() > deadline) throw new Error(`${id} did not stop within 30 seconds.`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await launch(id, options);
  }

  async function readDeviceSettings(emulator: RunningEmulator): Promise<DeviceSettings> {
    const output = await adbShell(
      paths,
      emulator,
      [
        "cmd uimode night",
        "settings get system font_scale",
        "wm density",
        "settings get secure navigation_mode",
        "getprop debug.layout",
        "settings get system show_touches",
      ].join("; echo ---; "),
    );
    const [night, font, density, nav, layout, touches] = output.split("---").map((part) => part.trim());
    const physical = Number(/Physical density: (\d+)/.exec(density ?? "")?.[1] ?? 0);
    const override = Number(/Override density: (\d+)/.exec(density ?? "")?.[1] ?? physical);
    return {
      darkTheme: /yes/.test(night ?? ""),
      fontScale: Number(font) || 1,
      density: override,
      physicalDensity: physical,
      navigation: nav === "0" ? "threebutton" : nav === "1" ? "twobutton" : "gestural",
      layoutBounds: layout === "true",
      showTouches: touches === "1",
    };
  }

  function settingCommand(setting: DeviceSettingChange): string {
    switch (setting.key) {
      case "darkTheme":
        return `cmd uimode night ${setting.value ? "yes" : "no"}`;
      case "fontScale":
        return `settings put system font_scale ${setting.value}`;
      case "density":
        return setting.value === null ? "wm density reset" : `wm density ${setting.value}`;
      case "navigation":
        return `cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.${setting.value}`;
      case "layoutBounds":
        // Poke system properties so running apps redraw with the new value.
        return `setprop debug.layout ${setting.value}; service call activity 1599295570 > /dev/null`;
      case "showTouches":
        return `settings put system show_touches ${setting.value ? 1 : 0}`;
    }
  }

  async function listFiles(emulator: RunningEmulator, dir: string) {
    // The trailing slash makes ls follow symlinks such as /sdcard.
    const output = await adbShell(paths, emulator, `ls -lA ${shellQuote(dir.endsWith("/") ? dir : `${dir}/`)}`).catch((error: Error) => {
      throw new Error(`Cannot list ${dir}: ${error.message}`);
    });
    const entries = output
      .split("\n")
      .map((line) => /^([dl-])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+ \S+)\s+(.+)$/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        name: match[1] === "l" ? match[4]!.split(" -> ")[0]! : match[4]!,
        directory: match[1] !== "-",
        size: Number(match[2]),
        modified: match[3]!,
      }))
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return { path: dir, entries };
  }

  bb.rpc.register(rpcContract, {
    devices: async () => ({ sdkPath: paths.sdk, sdkError: sdkError(), devices: await listDevices() }),
    launch: async ({ avdId: id, coldBoot, wipeData }) => {
      await launch(id, { coldBoot, wipeData });
      return DONE;
    },
    stop: async ({ avdId: id }) => {
      await stopEmulator(registry, paths, id);
      changed();
      return DONE;
    },
    createOptions: async () => ({
      profiles: DEVICE_PROFILES.map((profile) => ({
        id: profile.id,
        name: profile.name,
        screen: `${profile.width}×${profile.height} · ${profile.density} dpi`,
      })),
      systemImages: (await listSystemImages(paths)).map(({ path: imagePath, label }) => ({ path: imagePath, label })),
      devices: (await listAvds(paths)).map(({ id, name }) => ({ id, name })),
    }),
    create: async (input) => {
      const id = await createAvd(paths, input);
      changed();
      return { avdId: id };
    },
    duplicate: async ({ avdId: id, name }) => {
      const copy = await duplicateAvd(paths, id, name);
      changed();
      return { avdId: copy };
    },
    remove: async ({ avdId: id }) => {
      if (await registry.find(id)) throw new Error(`Stop ${id} before deleting it.`);
      await deleteAvd(paths, id);
      changed();
      return DONE;
    },
    snapshots: async ({ avdId: id }) => {
      const result = await registry.call<{
        snapshots: { snapshot_id: string; size: number; details?: { creation_time?: number } }[];
      }>(id, "snapshots", "ListSnapshots", { statusFilter: "All" });
      return {
        snapshots: result.snapshots
          .map((snapshot) => ({
            id: snapshot.snapshot_id,
            createdAt: snapshot.details?.creation_time ? snapshot.details.creation_time * 1000 : null,
            sizeBytes: snapshot.size || null,
          }))
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
      };
    },
    snapshotAction: async ({ avdId: id, action, snapshotId }) => {
      const method = { save: "SaveSnapshot", load: "LoadSnapshot", delete: "DeleteSnapshot" }[action];
      const result = await registry.call<{ success: boolean; err?: Buffer }>(
        id, "snapshots", method, { snapshot_id: snapshotId }, 120_000,
      );
      if (!result.success) {
        throw new Error(result.err?.toString("utf8") || `Could not ${action} snapshot ${snapshotId}.`);
      }
      return DONE;
    },
    deviceSettings: async ({ avdId: id }) => readDeviceSettings(await registry.require(id)),
    setDeviceSetting: async ({ avdId: id, setting }) => {
      await adbShell(paths, await registry.require(id), settingCommand(setting));
      return DONE;
    },
    deviceAction: async ({ avdId: id, action }) => {
      switch (action) {
        case "extendedControls":
          await registry.call(id, "ui", "showExtendedControls", { index: "KEEP_CURRENT" });
          break;
        case "fold":
        case "unfold": {
          const emulator = await registry.require(id);
          await run(paths.adb, ["-s", emulator.serial, "emu", action]);
          break;
        }
        case "coldBoot":
          await restart(id, { coldBoot: true });
          break;
        case "wipeData":
          await restart(id, { wipeData: true });
          break;
      }
      return DONE;
    },
    recording: async ({ avdId: id, action }) => {
      const emulator = await registry.require(id);
      const file = recordings.get(id);
      if (action === "start") {
        await mkdir(workDir, { recursive: true });
        const target = path.join(workDir, `${id}-${Date.now()}.webm`);
        await run(paths.adb, [
          "-s", emulator.serial, "emu", "screenrecord", "start",
          "--time-limit", String(RECORDING_TIME_LIMIT_SECONDS), target,
        ]);
        recordings.set(id, target);
        return { recording: true, downloadId: null };
      }
      if (action === "stop" && file) {
        await run(paths.adb, ["-s", emulator.serial, "emu", "screenrecord", "stop"]);
        recordings.delete(id);
        // The emulator finishes encoding asynchronously.
        const deadline = Date.now() + 15_000;
        while (!existsSync(file) || statSync(file).size === 0) {
          if (Date.now() > deadline) throw new Error("The recording did not finish writing.");
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { recording: false, downloadId: path.basename(file) };
      }
      return { recording: file !== undefined, downloadId: null };
    },
    files: async ({ avdId: id, path: dir }) => listFiles(await registry.require(id), dir),
    pasteText: async ({ avdId: id, text }) => {
      await registry.call(id, "controller", "setClipboard", { text });
      return DONE;
    },
  });

  // Live screen + input.
  bb.http.experimental_websocket("/screen", ({ url }) => {
    let session: ScreenSession | null = null;
    let queued: (string | Uint8Array)[] = [];
    return {
      async onOpen(socket) {
        try {
          const id = avdId.parse(url.searchParams.get("avd"));
          const emulator = await registry.require(id);
          const clients = registry.clientsFor(emulator);
          const status = await callUnary<{ hardwareConfig?: { entry?: { key: string; value: string }[] } }>(
            clients, "controller", "getStatus", {}, 5_000,
          );
          const config = new Map((status.hardwareConfig?.entry ?? []).map((entry) => [entry.key, entry.value]));
          session = new ScreenSession(
            socket,
            emulator,
            clients,
            {
              width: Number(config.get("hw.lcd.width")) || 1080,
              height: Number(config.get("hw.lcd.height")) || 1920,
            },
            (message) => bb.log.warn(message),
          );
          sessions.add(session);
          for (const message of queued) session.handle(message);
          queued = [];
          const width = Number(config.get("hw.lcd.width")) || 1080;
          cornerRadii(emulator).then(
            (corners) => corners && socket.send(JSON.stringify({ t: "display", corners, width })),
            (error: Error) => bb.log.debug(`corner radii for ${id}: ${error.message}`),
          );
        } catch (error) {
          socket.send(JSON.stringify({ t: "error", message: (error as Error).message }));
          socket.close(1011, "Could not attach to emulator");
        }
      },
      onMessage(_socket, data) {
        if (session) session.handle(data);
        else queued.push(data);
      },
      onClose() {
        if (session) {
          session.close();
          sessions.delete(session);
        }
      },
    };
  });

  // APK install / file push. The client sends binary chunks, then
  // {"t":"end"}; the server answers with {"t":"done"} or {"t":"error"}.
  bb.http.experimental_websocket("/upload", ({ url }) => {
    const name = path.basename(url.searchParams.get("name") ?? "upload.bin").replace(/[^\w.-]/g, "_");
    const target = path.join(workDir, "uploads", `${Date.now()}-${name}`);
    let written: Promise<void> = mkdir(path.dirname(target), { recursive: true }).then(() => writeFile(target, new Uint8Array()));
    return {
      async onMessage(socket, data) {
        if (typeof data !== "string") {
          written = written.then(() => appendFile(target, data));
          return;
        }
        try {
          await written;
          const id = avdId.parse(url.searchParams.get("avd"));
          const emulator = await registry.require(id);
          const install = name.toLowerCase().endsWith(".apk");
          const output = install
            ? await run(paths.adb, ["-s", emulator.serial, "install", "-r", "-t", target], { timeoutMs: 300_000 })
            : await run(paths.adb, ["-s", emulator.serial, "push", target, `/sdcard/Download/${name}`], { timeoutMs: 300_000 });
          socket.send(JSON.stringify({
            t: "done",
            message: install ? `Installed ${name}` : `Copied ${name} to /sdcard/Download`,
            detail: output.trim().split("\n").pop() ?? "",
          }));
        } catch (error) {
          socket.send(JSON.stringify({ t: "error", message: (error as Error).message }));
        } finally {
          await rm(target, { force: true });
          socket.close(1000, "done");
        }
      },
      async onClose() {
        await written.catch(() => undefined);
        await rm(target, { force: true });
      },
    };
  });

  bb.http.route("GET", "/screenshot", async (c) => {
    const id = avdId.parse(c.req.query("avd"));
    const image = await registry.call<{ image: Buffer }>(id, "controller", "getScreenshot", { format: "PNG" });
    return new Response(new Uint8Array(image.image), {
      headers: {
        "content-type": "image/png",
        "content-disposition": `attachment; filename="${id}-${Date.now()}.png"`,
      },
    });
  });

  bb.http.route("GET", "/recording", async (c) => {
    const id = path.basename(c.req.query("id") ?? "");
    const file = path.join(workDir, id);
    if (!/^[\w.-]+\.webm$/.test(id) || !existsSync(file)) return c.text("Recording not found", 404);
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      headers: { "content-type": "video/webm", "content-disposition": `attachment; filename="${id}"` },
    });
  });

  bb.http.route("GET", "/pull", async (c) => {
    const emulator = await registry.require(avdId.parse(c.req.query("avd")));
    const devicePath = c.req.query("path") ?? "";
    if (!devicePath.startsWith("/")) return c.text("Path must be absolute", 400);
    const child = spawn(paths.adb, ["-s", emulator.serial, "exec-out", `cat ${shellQuote(devicePath)}`]);
    return new Response(Readable.toWeb(child.stdout) as ReadableStream, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${path.posix.basename(devicePath).replace(/"/g, "")}"`,
      },
    });
  });

  // Announce device changes made outside BB (Android Studio, the CLI, crashes).
  bb.background.service("device-watch", {
    async start(signal) {
      let previous = "";
      while (!signal.aborted) {
        try {
          const devices = await listDevices();
          const signature = JSON.stringify(devices.map((device) => [device.id, device.status]));
          if (previous !== "" && signature !== previous) changed();
          previous = signature;
        } catch (error) {
          bb.log.debug(`device watch: ${(error as Error).message}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    },
  });

  const usage = [
    "Usage:",
    "  bb android-emulator list [--json]",
    "  bb android-emulator start <avd-id> [--cold-boot]",
    "  bb android-emulator stop <avd-id>",
  ].join("\n");
  bb.cli.register({
    name: "android-emulator",
    summary: "List, start, and stop the Android emulators shown in the BB side panel",
    commands: [
      { name: "list", summary: "List AVDs and whether they are running", usage: "bb android-emulator list [--json]" },
      { name: "start", summary: "Start an AVD headless so it appears in the panel", usage: "bb android-emulator start <avd-id> [--cold-boot]" },
      { name: "stop", summary: "Shut down a running emulator", usage: "bb android-emulator stop <avd-id>" },
    ],
    async run(argv) {
      const [command, target] = argv.filter((arg) => !arg.startsWith("--"));
      try {
        switch (command) {
          case "list": {
            const devices = await listDevices();
            if (argv.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(devices) };
            const lines = devices.map((device) =>
              `${device.id.padEnd(28)} ${device.status.padEnd(9)} API ${device.apiLevel.padEnd(6)} ${device.serial ?? ""}`,
            );
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "No AVDs found." };
          }
          case "start":
            if (!target) break;
            await launch(avdId.parse(target), { coldBoot: argv.includes("--cold-boot") });
            return { exitCode: 0, stdout: `Starting ${target}. Open the Android Emulator panel to see it.` };
          case "stop":
            if (!target) break;
            await stopEmulator(registry, paths, avdId.parse(target));
            changed();
            return { exitCode: 0, stdout: `Stopping ${target}.` };
          case undefined:
          case "help":
            return { exitCode: 0, stdout: usage };
        }
      } catch (error) {
        return { exitCode: 1, stderr: (error as Error).message };
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.onDispose(() => {
    for (const session of sessions) session.close();
    sessions.clear();
    registry.forget();
  });
}
