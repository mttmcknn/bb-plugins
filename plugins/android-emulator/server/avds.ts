// AVD inventory and creation. AVDs are plain directories under the AVD home:
// `<id>.ini` points at `<id>.avd/`, whose config.ini describes the hardware.
// Creating one is writing those two files, which is what avdmanager does.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatIni, parseIni, type SdkPaths } from "./sdk";

export interface Avd {
  id: string;
  name: string;
  apiLevel: string;
  device: string;
  imageTag: string;
  abi: string;
  screen: string;
}

export interface SystemImage {
  /** SDK-relative directory, as stored in config.ini `image.sysdir.1`. */
  path: string;
  label: string;
  apiLevel: string;
  tag: string;
  abi: string;
}

export interface DeviceProfile {
  id: string;
  name: string;
  width: number;
  height: number;
  density: number;
  tablet: boolean;
}

export const DEVICE_PROFILES: DeviceProfile[] = [
  profile("pixel_10_pro", "Pixel 10 Pro", 1280, 2856, 480),
  profile("pixel_10", "Pixel 10", 1080, 2424, 420),
  profile("pixel_10a", "Pixel 10a", 1080, 2424, 420),
  profile("pixel_9_pro_xl", "Pixel 9 Pro XL", 1344, 2992, 480),
  profile("pixel_9", "Pixel 9", 1080, 2424, 420),
  profile("pixel_8", "Pixel 8", 1080, 2400, 420),
  profile("pixel_7a", "Pixel 7a", 1080, 2400, 420),
  profile("medium_phone", "Medium Phone", 1080, 2400, 420),
  profile("small_phone", "Small Phone", 720, 1280, 320),
  profile("pixel_tablet", "Pixel Tablet", 2560, 1600, 320, true),
  profile("medium_tablet", "Medium Tablet", 2560, 1600, 320, true),
];

function profile(
  id: string,
  name: string,
  width: number,
  height: number,
  density: number,
  tablet = false,
): DeviceProfile {
  return { id, name, width, height, density, tablet };
}

export async function listAvds(paths: SdkPaths): Promise<Avd[]> {
  const entries = await readdir(paths.avdHome).catch(() => [] as string[]);
  const avds = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".ini"))
      .map(async (entry) => {
        const id = entry.slice(0, -".ini".length);
        try {
          const pointer = parseIni(
            await readFile(path.join(paths.avdHome, entry), "utf8"),
          );
          const dir = pointer.path ?? path.join(paths.avdHome, `${id}.avd`);
          const config = parseIni(
            await readFile(path.join(dir, "config.ini"), "utf8"),
          );
          return toAvd(id, config);
        } catch {
          return null;
        }
      }),
  );
  return avds
    .filter((avd): avd is Avd => avd !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function toAvd(id: string, config: Record<string, string>): Avd {
  const sysdir = config["image.sysdir.1"] ?? "";
  const apiLevel =
    /android-([\w.]+)/.exec(config.target ?? sysdir)?.[1] ?? "unknown";
  return {
    id,
    name: config["avd.ini.displayname"] || id.replaceAll("_", " "),
    apiLevel,
    device: config["hw.device.name"] ?? "",
    imageTag: config["tag.display"] ?? config["tag.id"] ?? "",
    abi: config["abi.type"] ?? "",
    screen:
      config["hw.lcd.width"] && config["hw.lcd.height"]
        ? `${config["hw.lcd.width"]}×${config["hw.lcd.height"]}`
        : "",
  };
}

export async function listSystemImages(
  paths: SdkPaths,
): Promise<SystemImage[]> {
  const root = path.join(paths.sdk, "system-images");
  const images: SystemImage[] = [];
  for (const platform of await readdir(root).catch(() => [] as string[])) {
    for (const tag of await readdir(path.join(root, platform)).catch(
      () => [] as string[],
    )) {
      for (const abi of await readdir(path.join(root, platform, tag)).catch(
        () => [] as string[],
      )) {
        const dir = path.join(root, platform, tag, abi);
        const properties = await readFile(
          path.join(dir, "source.properties"),
          "utf8",
        )
          .then(parseIni)
          .catch(() => null);
        if (properties === null) continue;
        const apiLevel = platform.replace(/^android-/, "");
        const tagDisplay = properties["SystemImage.TagDisplay"] ?? tag;
        images.push({
          path: `system-images/${platform}/${tag}/${abi}/`,
          label: `API ${apiLevel} · ${tagDisplay} · ${abi}`,
          apiLevel,
          tag,
          abi,
        });
      }
    }
  }
  return images.sort((a, b) =>
    b.apiLevel.localeCompare(a.apiLevel, undefined, { numeric: true }),
  );
}

export function toAvdId(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "");
}

async function assertNewAvd(paths: SdkPaths, id: string): Promise<void> {
  if (id === "") throw new Error("Use letters, digits, spaces, '.', '_' or '-' in the device name.");
  if (existsSync(path.join(paths.avdHome, `${id}.ini`))) {
    throw new Error(`A device with the ID ${id} already exists. Choose another name.`);
  }
}

async function writeAvd(
  paths: SdkPaths,
  id: string,
  config: Record<string, string>,
): Promise<void> {
  const dir = path.join(paths.avdHome, `${id}.avd`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "config.ini"), formatIni(config));
  await writeFile(
    path.join(paths.avdHome, `${id}.ini`),
    formatIni({
      "avd.ini.encoding": "UTF-8",
      path: dir,
      "path.rel": `avd/${id}.avd`,
      target: config.target ?? "",
    }),
  );
}

export async function createAvd(
  paths: SdkPaths,
  input: {
    name: string;
    profileId: string;
    systemImage: string;
    ramMb: number;
    storageGb: number;
  },
): Promise<string> {
  const id = toAvdId(input.name);
  await assertNewAvd(paths, id);
  const device = DEVICE_PROFILES.find((entry) => entry.id === input.profileId);
  if (!device) throw new Error(`Unknown device profile ${input.profileId}.`);
  const image = (await listSystemImages(paths)).find(
    (entry) => entry.path === input.systemImage,
  );
  if (!image) {
    throw new Error(
      `System image ${input.systemImage} is not installed. Install it with the SDK manager first.`,
    );
  }
  const imageProperties = parseIni(
    await readFile(
      path.join(paths.sdk, image.path, "source.properties"),
      "utf8",
    ),
  );
  const skinDir = path.join(paths.sdk, "skins", device.id);
  const hasSkin = existsSync(skinDir);
  const config: Record<string, string> = {
    "avd.ini.displayname": input.name.trim(),
    "avd.ini.encoding": "UTF-8",
    AvdId: id,
    "PlayStore.enabled": String(image.tag.includes("playstore")),
    "abi.type": image.abi,
    "disk.dataPartition.size": `${input.storageGb}G`,
    "fastboot.forceColdBoot": "no",
    "fastboot.forceFastBoot": "yes",
    "hw.accelerometer": "yes",
    "hw.audioInput": "yes",
    "hw.battery": "yes",
    "hw.camera.back": "virtualscene",
    "hw.camera.front": "emulated",
    "hw.cpu.arch": image.abi.startsWith("arm64") ? "arm64" : image.abi.startsWith("x86_64") ? "x86_64" : image.abi,
    "hw.cpu.ncore": "4",
    "hw.dPad": "no",
    "hw.device.manufacturer": "Google",
    "hw.device.name": device.id,
    "hw.gps": "yes",
    "hw.gpu.enabled": "yes",
    "hw.gpu.mode": "auto",
    "hw.gyroscope": "yes",
    "hw.initialOrientation": device.tablet ? "landscape" : "portrait",
    "hw.keyboard": "yes",
    "hw.lcd.density": String(device.density),
    "hw.lcd.height": String(device.height),
    "hw.lcd.width": String(device.width),
    "hw.mainKeys": "no",
    "hw.ramSize": String(input.ramMb),
    "hw.sdCard": "no",
    "hw.sensors.light": "yes",
    "hw.sensors.magnetic_field": "yes",
    "hw.sensors.orientation": "yes",
    "hw.sensors.pressure": "yes",
    "hw.sensors.proximity": "yes",
    "hw.trackBall": "no",
    "image.sysdir.1": image.path,
    "runtime.network.latency": "none",
    "runtime.network.speed": "full",
    showDeviceFrame: hasSkin ? "yes" : "no",
    "tag.display": imageProperties["SystemImage.TagDisplay"] ?? image.tag,
    "tag.id": image.tag,
    target: `android-${image.apiLevel}`,
    "skin.dynamic": "yes",
    "skin.name": hasSkin ? device.id : `${device.width}x${device.height}`,
    ...(hasSkin ? { "skin.path": skinDir } : {}),
  };
  await writeAvd(paths, id, config);
  return id;
}

/** Copies an AVD's hardware and image choice, without its user data. */
export async function duplicateAvd(
  paths: SdkPaths,
  sourceId: string,
  name: string,
): Promise<string> {
  const id = toAvdId(name);
  await assertNewAvd(paths, id);
  const sourceDir = path.join(paths.avdHome, `${sourceId}.avd`);
  const config = parseIni(
    await readFile(path.join(sourceDir, "config.ini"), "utf8"),
  );
  config["avd.ini.displayname"] = name.trim();
  config.AvdId = id;
  await writeAvd(paths, id, config);
  return id;
}

export async function deleteAvd(paths: SdkPaths, id: string): Promise<void> {
  const pointerPath = path.join(paths.avdHome, `${id}.ini`);
  const pointer = parseIni(await readFile(pointerPath, "utf8"));
  const dir = pointer.path ?? path.join(paths.avdHome, `${id}.avd`);
  if (!path.resolve(dir).startsWith(path.resolve(paths.avdHome))) {
    throw new Error(`Refusing to delete ${dir}: it is outside ${paths.avdHome}.`);
  }
  await rm(dir, { recursive: true, force: true });
  await rm(pointerPath, { force: true });
}

