// Android SDK locations and small process helpers shared by the backend.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SdkPaths {
  sdk: string;
  emulator: string;
  adb: string;
  protoDir: string;
  avdHome: string;
  /** Where running emulators write their pid_<pid>.ini discovery files. */
  discoveryDir: string;
}

export function resolveSdkPaths(configuredSdk: string): SdkPaths {
  const home = os.homedir();
  const sdk =
    [
      configuredSdk,
      process.env.ANDROID_HOME,
      process.env.ANDROID_SDK_ROOT,
      process.platform === "darwin"
        ? path.join(home, "Library/Android/sdk")
        : path.join(home, "Android/Sdk"),
    ].find((candidate) => candidate && existsSync(candidate)) ?? "";
  const adbInSdk = path.join(sdk, "platform-tools/adb");
  return {
    sdk,
    emulator: path.join(sdk, "emulator/emulator"),
    adb: existsSync(adbInSdk) ? adbInSdk : "adb",
    protoDir: path.join(sdk, "emulator/lib"),
    avdHome:
      process.env.ANDROID_AVD_HOME ??
      path.join(
        process.env.ANDROID_USER_HOME ?? path.join(home, ".android"),
        "avd",
      ),
    discoveryDir:
      process.platform === "darwin"
        ? path.join(home, "Library/Caches/TemporaryItems/avd/running")
        : path.join(
            process.env.XDG_RUNTIME_DIR ??
              path.join(os.tmpdir(), `android-${os.userInfo().username}`),
            "avd/running",
          ),
  };
}

export function run(
  file: string,
  args: string[],
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || "").trim();
          reject(new Error(detail || error.message));
        } else {
          resolve(String(stdout));
        }
      },
    );
  });
}

/** Parses the key=value format used by AVD config.ini and discovery files. */
export function parseIni(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0 || line.startsWith("#")) continue;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

export function formatIni(values: Record<string, string>): string {
  return (
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  );
}

/** Single-quotes a value for `adb shell`, which runs it through sh. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
