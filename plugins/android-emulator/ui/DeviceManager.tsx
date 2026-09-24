// Device manager: every AVD with start/stop, plus create, duplicate, delete.
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { Device } from "../server";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorMessage, reportError, ToolButton, useEmulatorRpc, type EmulatorRpc } from "./common";
import { Glyph } from "./icons";

export function StatusDot({ status }: { status: Device["status"] }) {
  const color = {
    running: "bg-emerald-500",
    booting: "bg-amber-500 animate-pulse",
    starting: "bg-amber-500 animate-pulse",
    stopped: "bg-muted-foreground/40",
  }[status];
  return <span className={`inline-block size-2 shrink-0 rounded-full ${color}`} aria-hidden />;
}

export const STATUS_LABEL: Record<Device["status"], string> = {
  running: "Running",
  booting: "Booting",
  starting: "Starting",
  stopped: "Stopped",
};

export function startDevice(rpc: EmulatorRpc, device: Device, options: { coldBoot?: boolean; wipeData?: boolean } = {}) {
  return rpc.call("launch", { avdId: device.id, ...options }).then(
    () => toast.success(`Starting ${device.name}`),
    reportError,
  );
}

export function DeviceManager({
  devices,
  sdkError,
  onOpen,
  onCreate,
}: {
  devices: Device[];
  sdkError: string | null;
  onOpen: (avdId: string) => void;
  onCreate: () => void;
}) {
  const rpc = useEmulatorRpc();
  const [duplicating, setDuplicating] = useState<Device | null>(null);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto w-full max-w-xl space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Virtual devices</h2>
          <Button size="sm" onClick={onCreate} disabled={sdkError !== null}>
            <Glyph name="add" /> Create device
          </Button>
        </div>
        {sdkError ? <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{sdkError}</p> : null}
        {devices.length === 0 && !sdkError ? (
          <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">
            No virtual devices yet. Create one to get started.
          </p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {devices.map((device) => (
              <li key={device.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <Glyph name="device" className="size-5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{device.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    API {device.apiLevel}
                    {device.imageTag ? ` · ${device.imageTag}` : ""}
                    {device.screen ? ` · ${device.screen}` : ""}
                  </p>
                </div>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <StatusDot status={device.status} />
                  {STATUS_LABEL[device.status]}
                </span>
                {device.status === "stopped" ? (
                  <ToolButton icon="play" label={`Start ${device.name}`} onClick={() => void startDevice(rpc, device)} />
                ) : device.status === "starting" ? (
                  <ToolButton icon="loading" label="Starting…" disabled />
                ) : (
                  <ToolButton icon="arrowLeft" iconClassName="rotate-180" label={`Show ${device.name}`} onClick={() => onOpen(device.id)} />
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <ToolButton icon="more" label={`${device.name} actions`} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {device.status === "stopped" ? (
                      <>
                        <DropdownMenuItem onSelect={() => void startDevice(rpc, device, { coldBoot: true })}>Cold boot</DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            if (window.confirm(`Erase all data on ${device.name} and start it?`)) {
                              void startDevice(rpc, device, { wipeData: true });
                            }
                          }}
                        >
                          Wipe data and start
                        </DropdownMenuItem>
                      </>
                    ) : (
                      <DropdownMenuItem
                        onSelect={() => rpc.call("stop", { avdId: device.id }).then(() => toast.success(`Stopping ${device.name}`), reportError)}
                      >
                        Stop
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => setDuplicating(device)}>Duplicate…</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={device.status !== "stopped"}
                      onSelect={() => {
                        if (!window.confirm(`Delete ${device.name} and all of its data? This cannot be undone.`)) return;
                        rpc.call("remove", { avdId: device.id }).then(() => toast.success(`Deleted ${device.name}`), reportError);
                      }}
                    >
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </div>
      <DuplicateDialog device={duplicating} onClose={() => setDuplicating(null)} />
    </div>
  );
}

function DuplicateDialog({ device, onClose }: { device: Device | null; onClose: () => void }) {
  const rpc = useEmulatorRpc();
  const [name, setName] = useState("");
  useEffect(() => setName(device ? `${device.name} copy` : ""), [device]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!device) return;
    rpc.call("duplicate", { avdId: device.id, name }).then(() => {
      toast.success(`Created ${name}`);
      onClose();
    }, reportError);
  }

  return (
    <Dialog open={device !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Duplicate {device?.name}</DialogTitle>
            <DialogDescription>Copies the hardware and system image. User data is not copied.</DialogDescription>
          </DialogHeader>
          <Input value={name} onChange={(event) => setName(event.target.value)} aria-label="New device name" autoFocus />
          <DialogFooter>
            <Button type="submit" disabled={name.trim() === ""}>Duplicate</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface CreateOptions {
  profiles: { id: string; name: string; screen: string }[];
  systemImages: { path: string; label: string }[];
}

export function CreateDeviceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (avdId: string) => void;
}) {
  const rpc = useEmulatorRpc();
  const [options, setOptions] = useState<CreateOptions | null>(null);
  const [name, setName] = useState("");
  const [profileId, setProfileId] = useState("");
  const [systemImage, setSystemImage] = useState("");
  const [ramMb, setRamMb] = useState("2048");
  const [storageGb, setStorageGb] = useState("8");
  const [startAfter, setStartAfter] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    rpc.call("createOptions").then((result) => {
      setOptions(result);
      const profile = result.profiles[0];
      setProfileId((current) => current || profile?.id || "");
      setName((current) => current || profile?.name || "");
      setSystemImage((current) => current || result.systemImages[0]?.path || "");
    }, reportError);
  }, [open, rpc]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { avdId } = await rpc.call("create", {
        name,
        profileId,
        systemImage,
        ramMb: Number(ramMb),
        storageGb: Number(storageGb),
      });
      if (startAfter) await rpc.call("launch", { avdId });
      toast.success(startAfter ? `Created ${name}. Starting it now.` : `Created ${name}`);
      onCreated(avdId);
      onOpenChange(false);
      setName("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const profileName = (id: string) => options?.profiles.find((profile) => profile.id === id)?.name;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Create virtual device</DialogTitle>
            <DialogDescription>Uses a system image already installed in your Android SDK.</DialogDescription>
          </DialogHeader>
          {options === null ? (
            <p className="text-sm text-muted-foreground">Loading options…</p>
          ) : options.systemImages.length === 0 ? (
            <p className="text-sm text-destructive">
              No system images are installed. Install one in Android Studio's SDK Manager, then try again.
            </p>
          ) : (
            <div className="space-y-3 text-sm">
              <Field label="Device">
                <Select
                  value={profileId}
                  onValueChange={(value) => {
                    // Keep the name in sync until the user edits it.
                    if (name === "" || name === profileName(profileId)) setName(profileName(value) ?? name);
                    setProfileId(value);
                  }}
                >
                  <SelectTrigger aria-label="Device profile"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {options.profiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.name} <span className="text-muted-foreground">· {profile.screen}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="System image">
                <Select value={systemImage} onValueChange={setSystemImage}>
                  <SelectTrigger aria-label="System image"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {options.systemImages.map((image) => (
                      <SelectItem key={image.path} value={image.path}>{image.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Name">
                <Input value={name} onChange={(event) => setName(event.target.value)} aria-label="Device name" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="RAM (MB)">
                  <Input type="number" min={1024} max={16384} step={512} value={ramMb} onChange={(event) => setRamMb(event.target.value)} aria-label="RAM in megabytes" />
                </Field>
                <Field label="Storage (GB)">
                  <Input type="number" min={2} max={256} value={storageGb} onChange={(event) => setStorageGb(event.target.value)} aria-label="Internal storage in gigabytes" />
                </Field>
              </div>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={startAfter} onChange={(event) => setStartAfter(event.target.checked)} />
                Start the device after creating it
              </label>
              <p className="text-xs text-muted-foreground">To make a foldable or a custom device, duplicate an existing one from the device list.</p>
            </div>
          )}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="submit" disabled={busy || !options || !systemImage || !profileId || name.trim() === ""}>
              {busy ? <Glyph name="loading" /> : null} Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}
