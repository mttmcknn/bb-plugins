// Running emulators and their gRPC control channel.
//
// Every running emulator writes `pid_<pid>.ini` into the discovery directory
// with its gRPC port and bearer token. That is the same channel Android
// Studio's embedded emulator uses: screenshots stream out, input goes in.
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseIni, run, type SdkPaths } from "./sdk";

export interface RunningEmulator {
  avdId: string;
  pid: number;
  serial: string;
  grpcPort: number;
  token: string | null;
}

type Callback<T> = (error: grpc.ServiceError | null, value?: T) => void;
type UnaryMethod = (
  request: object,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: Callback<unknown>,
) => grpc.ClientUnaryCall;
type ServiceClient = grpc.Client & Record<string, UnaryMethod>;

export interface EmulatorClients {
  controller: ServiceClient;
  snapshots: ServiceClient;
  ui: ServiceClient;
  metadata: grpc.Metadata;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone we cannot signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function listRunning(paths: SdkPaths): Promise<RunningEmulator[]> {
  const files = await readdir(paths.discoveryDir).catch(() => [] as string[]);
  const running: RunningEmulator[] = [];
  for (const file of files) {
    const pid = Number(/^pid_(\d+)\.ini$/.exec(file)?.[1]);
    if (!pid || !isAlive(pid)) continue;
    const values = await readFile(path.join(paths.discoveryDir, file), "utf8")
      .then(parseIni)
      .catch(() => null);
    const grpcPort = Number(values?.["grpc.port"]);
    if (!values || !values["avd.id"] || !grpcPort) continue;
    running.push({
      avdId: values["avd.id"],
      pid,
      serial: `emulator-${values["port.serial"]}`,
      grpcPort,
      token: values["grpc.token"] || null,
    });
  }
  return running;
}

export class EmulatorRegistry {
  private definitions: grpc.GrpcObject | null = null;
  private clients = new Map<string, EmulatorClients>();

  constructor(private readonly paths: () => SdkPaths) {}

  private loadDefinitions(): grpc.GrpcObject {
    if (this.definitions) return this.definitions;
    const { protoDir } = this.paths();
    const files = [
      "emulator_controller.proto",
      "snapshot_service.proto",
      "ui_controller_service.proto",
    ].map((file) => path.join(protoDir, file));
    const missing = files.find((file) => !existsSync(file));
    if (missing) {
      throw new Error(
        `Missing ${missing}. Update the Android Emulator package in the SDK manager.`,
      );
    }
    this.definitions = grpc.loadPackageDefinition(
      protoLoader.loadSync(files, {
        keepCase: true,
        longs: Number,
        enums: String,
        defaults: true,
        includeDirs: [protoDir],
      }),
    );
    return this.definitions;
  }

  async find(avdId: string): Promise<RunningEmulator | null> {
    return (
      (await listRunning(this.paths())).find(
        (emulator) => emulator.avdId === avdId,
      ) ?? null
    );
  }

  async require(avdId: string): Promise<RunningEmulator> {
    const emulator = await this.find(avdId);
    if (!emulator) throw new Error(`${avdId} is not running. Start it first.`);
    return emulator;
  }

  clientsFor(emulator: RunningEmulator): EmulatorClients {
    const key = `${emulator.grpcPort}:${emulator.token}`;
    const cached = this.clients.get(key);
    if (cached) return cached;
    const definitions = this.loadDefinitions() as unknown as {
      android: {
        emulation: {
          control: Record<string, grpc.ServiceClientConstructor>;
        };
      };
    };
    const control = definitions.android.emulation.control;
    const address = `127.0.0.1:${emulator.grpcPort}`;
    const credentials = grpc.credentials.createInsecure();
    const options = { "grpc.max_receive_message_length": 256 * 1024 * 1024 };
    const controller = new control.EmulatorController!(
      address,
      credentials,
      options,
    ) as unknown as ServiceClient;
    // Share one HTTP/2 channel across the three services.
    const channelOverride = { channelOverride: controller.getChannel() };
    const metadata = new grpc.Metadata();
    if (emulator.token) metadata.set("authorization", `Bearer ${emulator.token}`);
    const clients: EmulatorClients = {
      controller,
      snapshots: new control.SnapshotService!(address, credentials, {
        ...options,
        ...channelOverride,
      }) as unknown as ServiceClient,
      ui: new control.UiController!(address, credentials, {
        ...options,
        ...channelOverride,
      }) as unknown as ServiceClient,
      metadata,
    };
    this.clients.set(key, clients);
    return clients;
  }

  /** Calls a unary gRPC method on a running emulator. */
  async call<T = Record<string, unknown>>(
    avdId: string,
    service: "controller" | "snapshots" | "ui",
    method: string,
    request: object = {},
    timeoutMs = 15_000,
  ): Promise<T> {
    const clients = this.clientsFor(await this.require(avdId));
    return callUnary<T>(clients, service, method, request, timeoutMs);
  }

  forget(): void {
    for (const clients of this.clients.values()) clients.controller.close();
    this.clients.clear();
  }
}

export function callUnary<T>(
  clients: EmulatorClients,
  service: "controller" | "snapshots" | "ui",
  method: string,
  request: object,
  timeoutMs = 15_000,
): Promise<T> {
  const client = clients[service];
  const fn = client[method];
  if (typeof fn !== "function") {
    return Promise.reject(new Error(`This emulator does not support ${method}.`));
  }
  return new Promise((resolve, reject) => {
    fn.call(
      client,
      request,
      clients.metadata,
      { deadline: Date.now() + timeoutMs },
      (error, value) => (error ? reject(new Error(error.details || error.message)) : resolve(value as T)),
    );
  });
}

export interface LaunchOptions {
  coldBoot?: boolean;
  wipeData?: boolean;
  /** Shut the emulator down when this process (the BB server) exits. */
  ownerPid?: number;
}

// Runs detached beside the emulator. While both the owner and the emulator's
// process group are alive it sleeps; once the owner is gone it sends SIGTERM
// (the emulator shuts down cleanly and saves its Quick Boot state), then
// SIGKILL if the group is still alive 30 seconds later. Polling a pid covers
// quit, crash, and force-quit alike, and plugin reloads keep the same owner.
const WATCHDOG = `
owner="$1"; group="$2"
while kill -0 "$owner" 2>/dev/null && kill -0 -- "-$group" 2>/dev/null; do sleep 2; done
kill -0 -- "-$group" 2>/dev/null || exit 0
kill -TERM -- "-$group" 2>/dev/null
i=0
while [ "$i" -lt 30 ] && kill -0 -- "-$group" 2>/dev/null; do sleep 1; i=$((i + 1)); done
kill -KILL -- "-$group" 2>/dev/null
`;

export function launchEmulator(
  paths: SdkPaths,
  avdId: string,
  logFile: string,
  options: LaunchOptions = {},
): void {
  if (!existsSync(paths.emulator)) {
    throw new Error(
      `No emulator binary at ${paths.emulator}. Set the Android SDK path in the plugin settings.`,
    );
  }
  const args = [
    "-avd",
    avdId,
    // Same flags Android Studio uses for embedded emulators: no Qt window,
    // gRPC guarded by a token written to the discovery file.
    "-qt-hide-window",
    "-grpc-use-token",
    ...(options.coldBoot ? ["-no-snapshot-load"] : []),
    ...(options.wipeData ? ["-wipe-data"] : []),
  ];
  const log = openSync(logFile, "a");
  const child = spawn(paths.emulator, args, {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, ANDROID_HOME: paths.sdk, ANDROID_SDK_ROOT: paths.sdk },
  });
  closeSync(log);
  child.unref();
  // detached makes the emulator a process-group leader, so its pid is the
  // group id and covers the qemu child it starts.
  if (options.ownerPid !== undefined && child.pid !== undefined) {
    spawn("/bin/sh", ["-c", WATCHDOG, "watchdog", String(options.ownerPid), String(child.pid)], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
}

export async function stopEmulator(
  registry: EmulatorRegistry,
  paths: SdkPaths,
  avdId: string,
): Promise<void> {
  const emulator = await registry.require(avdId);
  try {
    await callUnary(
      registry.clientsFor(emulator),
      "controller",
      "setVmState",
      { state: "SHUTDOWN" },
      5_000,
    );
  } catch {
    await run(paths.adb, ["-s", emulator.serial, "emu", "kill"]);
  }
}

export function adbShell(
  paths: SdkPaths,
  emulator: RunningEmulator,
  command: string,
  timeoutMs?: number,
): Promise<string> {
  return run(paths.adb, ["-s", emulator.serial, "shell", command], { timeoutMs });
}

/** Rounded-corner radii in natural display pixels: [topLeft, topRight, bottomRight, bottomLeft]. */
export type CornerRadii = [number, number, number, number];

/**
 * Reads the default display's rounded corners from `dumpsys display`.
 * SystemUI paints black over these corners, so the panel clips to them.
 */
export async function readCornerRadii(paths: SdkPaths, emulator: RunningEmulator): Promise<CornerRadii | null> {
  const output = await adbShell(paths, emulator, "dumpsys display", 10_000);
  const block = /RoundedCorners\{\[(.*?)\]\}/s.exec(output)?.[1];
  if (!block) return null;
  const radius = (position: string) =>
    Number(new RegExp(`position=${position}, radius=(\\d+)`).exec(block)?.[1] ?? 0);
  return [radius("TopLeft"), radius("TopRight"), radius("BottomRight"), radius("BottomLeft")];
}
