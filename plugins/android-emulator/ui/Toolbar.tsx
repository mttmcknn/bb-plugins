// The device toolbar, laid out like Android Studio's Running Devices window:
// power/volume, rotation, navigation, device settings, input mode, capture,
// file transfer, snapshots, and an overflow menu.
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { toast } from "sonner";
import type { Device, DeviceFile, DeviceSettingChange, DeviceSettings, Snapshot } from "../server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  download,
  errorMessage,
  reportError,
  ToolButton,
  ToolDivider,
  upload,
  useEmulatorRpc,
} from "./common";
import { Glyph } from "./icons";
import type { SendToScreen } from "./Screen";

export function Toolbar({
  device,
  send,
  mouseMode,
  onMouseModeChange,
}: {
  device: Device;
  send: SendToScreen | null;
  mouseMode: boolean;
  onMouseModeChange: (value: boolean) => void;
}) {
  const rpc = useEmulatorRpc();
  const [recording, setRecording] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const avdId = device.id;

  useEffect(() => {
    rpc.call("recording", { avdId, action: "status" }).then((result) => setRecording(result.recording), () => undefined);
  }, [rpc, avdId]);

  /** Press-and-hold handlers so long-press power works like the hardware key. */
  const hold = useCallback(
    (key: string) => ({
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        send?.({ t: "key", key, type: "down" });
      },
      onPointerUp: () => send?.({ t: "key", key, type: "up" }),
      onPointerCancel: () => send?.({ t: "key", key, type: "up" }),
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          send?.({ t: "key", key, type: "press" });
        }
      },
    }),
    [send],
  );

  async function screenshot() {
    try {
      await download("/screenshot", { avd: avdId }, `${avdId}.png`);
    } catch (error) {
      reportError(error);
    }
  }

  async function toggleRecording() {
    try {
      if (!recording) {
        await rpc.call("recording", { avdId, action: "start" });
        setRecording(true);
        toast.message("Recording the screen (up to 3 minutes). Click again to stop.");
        return;
      }
      const pending = toast.loading("Saving recording…");
      setRecording(false);
      const result = await rpc.call("recording", { avdId, action: "stop" });
      if (result.downloadId) await download("/recording", { id: result.downloadId }, result.downloadId);
      toast.success("Recording saved", { id: pending });
    } catch (error) {
      reportError(error);
    }
  }

  function uploadFiles(files: FileList | null) {
    for (const file of Array.from(files ?? [])) {
      const pending = toast.loading(`Sending ${file.name}…`);
      upload(avdId, file).then(
        (message) => toast.success(message, { id: pending }),
        (error: unknown) => toast.error(errorMessage(error), { id: pending }),
      );
    }
  }

  const disabled = send === null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-y-1 border-b border-border px-2 py-1">
      <ToolButton icon="power" label="Power (hold for power menu)" disabled={disabled} {...hold("Power")} />
      <ToolButton icon="volumeUp" label="Volume up" disabled={disabled} {...hold("AudioVolumeUp")} />
      <ToolButton icon="volumeDown" label="Volume down" disabled={disabled} {...hold("AudioVolumeDown")} />
      <ToolDivider />
      <ToolButton icon="rotateLeft" label="Rotate left" disabled={disabled} onClick={() => send?.({ t: "rotate", dir: "left" })} />
      <ToolButton icon="rotateRight" label="Rotate right" disabled={disabled} onClick={() => send?.({ t: "rotate", dir: "right" })} />
      <ToolDivider />
      <ToolButton icon="back" label="Back" disabled={disabled} {...hold("GoBack")} />
      <ToolButton icon="home" label="Home" disabled={disabled} {...hold("GoHome")} />
      <ToolButton icon="overview" label="Overview" disabled={disabled} {...hold("AppSwitch")} />
      <ToolDivider />
      <DeviceSettingsButton avdId={avdId} disabled={disabled} />
      <ToolButton
        icon="keyboard"
        label={mouseMode ? "Mouse input: on (clicks are mouse events)" : "Mouse input: off (clicks are touches)"}
        active={mouseMode}
        onClick={() => onMouseModeChange(!mouseMode)}
      />
      <ToolDivider />
      <ToolButton icon="camera" label="Take screenshot" disabled={disabled} onClick={screenshot} />
      <ToolButton
        icon="record"
        label={recording ? "Stop screen recording" : "Record screen"}
        active={recording}
        iconClassName={recording ? "text-red-500" : undefined}
        disabled={disabled}
        onClick={toggleRecording}
      />
      <ToolDivider />
      <ToolButton icon="upload" label="Install APK or copy file to device" disabled={disabled} onClick={() => fileInput.current?.click()} />
      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          uploadFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <ToolButton icon="download" label="Download files from device" disabled={disabled} onClick={() => setFilesOpen(true)} />
      <ToolDivider />
      <SnapshotsButton avdId={avdId} disabled={disabled} />
      <MoreMenu device={device} disabled={disabled} />
      <FilesDialog avdId={avdId} open={filesOpen} onOpenChange={setFilesOpen} />
    </div>
  );
}

const FONT_SCALES = [
  { value: 0.85, label: "Small" },
  { value: 1, label: "Default" },
  { value: 1.15, label: "Large" },
  { value: 1.3, label: "Largest" },
];

function DeviceSettingsButton({ avdId, disabled }: { avdId: string; disabled: boolean }) {
  const rpc = useEmulatorRpc();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<DeviceSettings | null>(null);

  const load = useCallback(() => {
    rpc.call("deviceSettings", { avdId }).then(setSettings, reportError);
  }, [rpc, avdId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  function apply(setting: DeviceSettingChange) {
    rpc.call("setDeviceSetting", { avdId, setting }).then(load, reportError);
  }

  const densities = settings
    ? [
        { value: Math.round(settings.physicalDensity * 0.85), label: "Small" },
        { value: null, label: "Default" },
        { value: Math.round(settings.physicalDensity * 1.15), label: "Large" },
        { value: Math.round(settings.physicalDensity * 1.3), label: "Largest" },
      ]
    : [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ToolButton icon="settings" label="Device UI settings" disabled={disabled} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3 p-3 text-sm" mobileTitle="Device UI settings">
        {settings === null ? (
          <p className="text-muted-foreground">Reading device settings…</p>
        ) : (
          <>
            <Toggle label="Dark theme" checked={settings.darkTheme} onChange={(value) => apply({ key: "darkTheme", value })} />
            <Toggle
              label="Gesture navigation"
              checked={settings.navigation === "gestural"}
              onChange={(value) => apply({ key: "navigation", value: value ? "gestural" : "threebutton" })}
            />
            <Toggle label="Show layout bounds" checked={settings.layoutBounds} onChange={(value) => apply({ key: "layoutBounds", value })} />
            <Toggle label="Show taps" checked={settings.showTouches} onChange={(value) => apply({ key: "showTouches", value })} />
            <Segmented
              label="Font size"
              options={FONT_SCALES.map((option) => ({ ...option, selected: Math.abs(settings.fontScale - option.value) < 0.01 }))}
              onSelect={(value) => apply({ key: "fontScale", value: value as number })}
            />
            <Segmented
              label="Display size"
              options={densities.map((option) => ({
                ...option,
                selected: option.value === null ? settings.density === settings.physicalDensity : settings.density === option.value,
              }))}
              onSelect={(value) => apply({ key: "density", value: value as number | null })}
            />
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-foreground" : "bg-muted-foreground/30",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 size-4 rounded-full bg-background transition-transform",
            checked && "translate-x-4",
          )}
        />
      </button>
    </label>
  );
}

function Segmented<T>({
  label,
  options,
  onSelect,
}: {
  label: string;
  options: { value: T; label: string; selected: boolean }[];
  onSelect: (value: T) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p>{label}</p>
      <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={option.selected}
            onClick={() => onSelect(option.value)}
            className={cn(
              "rounded-md border px-1.5 py-1 text-xs",
              option.selected ? "border-foreground bg-state-active text-foreground" : "border-border text-muted-foreground hover:bg-state-hover",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SnapshotsButton({ avdId, disabled }: { avdId: string; disabled: boolean }) {
  const rpc = useEmulatorRpc();
  const [open, setOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    rpc.call("snapshots", { avdId }).then((result) => setSnapshots(result.snapshots), reportError);
  }, [rpc, avdId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function act(action: "save" | "load" | "delete", snapshotId: string) {
    setBusy(true);
    const pending = toast.loading(
      action === "save" ? `Saving ${snapshotId}…` : action === "load" ? `Loading ${snapshotId}…` : `Deleting ${snapshotId}…`,
    );
    try {
      await rpc.call("snapshotAction", { avdId, action, snapshotId });
      toast.success(action === "save" ? "Snapshot saved" : action === "load" ? "Snapshot loaded" : "Snapshot deleted", { id: pending });
      if (action === "save") setName("");
      load();
    } catch (error) {
      toast.error(errorMessage(error), { id: pending });
    } finally {
      setBusy(false);
    }
  }

  const snapshotName = name.trim().replace(/\s+/g, "_");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ToolButton icon="snapshots" label="Snapshots" disabled={disabled} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 p-3 text-sm" mobileTitle="Snapshots">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (snapshotName) void act("save", snapshotName);
          }}
        >
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Snapshot name" aria-label="Snapshot name" className="h-8" />
          <Button type="submit" size="sm" disabled={busy || !/^[\w.-]{1,64}$/.test(snapshotName)}>
            Save
          </Button>
        </form>
        {snapshots === null ? (
          <p className="text-muted-foreground">Loading snapshots…</p>
        ) : snapshots.length === 0 ? (
          <p className="text-muted-foreground">No snapshots yet.</p>
        ) : (
          <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {snapshots.map((snapshot) => (
              <li key={snapshot.id} className="flex items-center gap-2 px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate">{snapshot.id}</p>
                  {snapshot.createdAt ? (
                    <p className="text-xs text-muted-foreground">{new Date(snapshot.createdAt).toLocaleString()}</p>
                  ) : null}
                </div>
                <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => act("load", snapshot.id)}>
                  Load
                </Button>
                <ToolButton icon="delete" label={`Delete ${snapshot.id}`} className="size-7" disabled={busy} onClick={() => act("delete", snapshot.id)} />
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function MoreMenu({ device, disabled }: { device: Device; disabled: boolean }) {
  const rpc = useEmulatorRpc();
  const avdId = device.id;
  const foldable = /fold/i.test(device.device);

  function action(name: "extendedControls" | "fold" | "unfold" | "coldBoot" | "wipeData", message?: string) {
    rpc.call("deviceAction", { avdId, action: name }).then(() => message && toast.success(message), reportError);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ToolButton icon="more" label="More" disabled={disabled} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => action("extendedControls")}>Extended controls…</DropdownMenuItem>
        {foldable ? (
          <>
            <DropdownMenuItem onSelect={() => action("fold")}>Fold</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => action("unfold")}>Unfold</DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => action("coldBoot", "Cold booting…")}>Cold boot</DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            if (window.confirm(`Erase all data on ${device.name} and restart it?`)) action("wipeData", "Wiping data and restarting…");
          }}
        >
          Wipe data and restart
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => rpc.call("stop", { avdId }).then(() => toast.success(`Stopping ${device.name}`), reportError)}
        >
          Stop emulator
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FilesDialog({ avdId, open, onOpenChange }: { avdId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const rpc = useEmulatorRpc();
  const [dir, setDir] = useState("/sdcard/Download");
  const [entries, setEntries] = useState<DeviceFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEntries(null);
    setError(null);
    rpc.call("files", { avdId, path: dir }).then(
      (result) => setEntries(result.entries),
      (cause: unknown) => setError(errorMessage(cause)),
    );
  }, [rpc, avdId, dir, open]);

  const parent = dir === "/" ? null : dir.replace(/\/[^/]+\/?$/, "") || "/";
  const join = (name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Download from {avdId}</DialogTitle>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = new FormData(event.currentTarget).get("path");
            if (typeof value === "string" && value.startsWith("/")) setDir(value);
          }}
        >
          <Input key={dir} name="path" defaultValue={dir} aria-label="Device folder" className="h-8 font-mono text-xs" />
          <Button type="submit" size="sm" variant="outline">
            Go
          </Button>
        </form>
        <div className="max-h-80 min-h-40 overflow-y-auto rounded-md border border-border text-sm">
          {parent !== null ? (
            <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-state-hover" onClick={() => setDir(parent)}>
              <Glyph name="arrowLeft" /> ..
            </button>
          ) : null}
          {error ? (
            <p className="p-3 text-destructive">{error}</p>
          ) : entries === null ? (
            <p className="p-3 text-muted-foreground">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="p-3 text-muted-foreground">This folder is empty.</p>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.name}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-state-hover"
                onClick={() => {
                  if (entry.directory) {
                    setDir(join(entry.name));
                    return;
                  }
                  download("/pull", { avd: avdId, path: join(entry.name) }, entry.name).catch(reportError);
                }}
              >
                <Glyph name={entry.directory ? "folder" : "file"} className="text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.directory ? null : <span className="text-xs text-muted-foreground">{formatBytes(entry.size)}</span>}
              </button>
            ))
          )}
        </div>
        <p className="text-xs text-muted-foreground">Click a file to download it. Drop files on the screen to send them to the device.</p>
      </DialogContent>
    </Dialog>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
