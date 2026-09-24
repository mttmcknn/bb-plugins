// The side-panel tab: one tab per running emulator, a device manager, and the
// live screen with Android Studio-style controls for the selected emulator.
import { useCallback, useEffect, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Device } from "../server";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { reportError, ToolButton, useEmulatorRpc } from "./common";
import { CreateDeviceDialog, DeviceManager, startDevice, StatusDot, STATUS_LABEL } from "./DeviceManager";
import { Screen, type SendToScreen } from "./Screen";
import { Toolbar } from "./Toolbar";

const MANAGER = "__manager__";

function useDevices() {
  const rpc = useEmulatorRpc();
  const [state, setState] = useState<{ devices: Device[]; sdkError: string | null } | null>(null);
  const refetch = useCallback(() => {
    rpc.call("devices").then((result) => setState(result), reportError);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("devices-changed", refetch);
  // Poll while something is starting so the tab turns live without waiting
  // for the 2-second server watch.
  const transitioning = state?.devices.some((device) => device.status === "starting" || device.status === "booting");
  useEffect(() => {
    if (!transitioning) return;
    const timer = setInterval(refetch, 1_500);
    return () => clearInterval(timer);
  }, [transitioning, refetch]);
  return { state, refetch };
}

export function EmulatorPanel({ initialAvdId }: { initialAvdId?: string | null }) {
  const rpc = useEmulatorRpc();
  const { state } = useDevices();
  const [selected, setSelected] = useState<string | null>(initialAvdId ?? null);
  const [createOpen, setCreateOpen] = useState(false);
  const [send, setSend] = useState<SendToScreen | null>(null);
  const [mouseMode, setMouseMode] = useState(false);
  const onSendReady = useCallback((next: SendToScreen | null) => setSend(() => next), []);

  const devices = state?.devices ?? [];
  const open = devices.filter((device) => device.status !== "stopped");
  const stopped = devices.filter((device) => device.status === "stopped");
  const active =
    selected === MANAGER ? null : (open.find((device) => device.id === selected) ?? open[0] ?? null);
  const showManager = active === null;

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1" role="tablist" aria-label="Emulators">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {open.map((device) => (
              <button
                key={device.id}
                type="button"
                role="tab"
                aria-selected={active?.id === device.id}
                title={`${device.name} · ${STATUS_LABEL[device.status]}`}
                onClick={() => setSelected(device.id)}
                className={cn(
                  "flex h-7 max-w-48 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs",
                  active?.id === device.id ? "bg-state-active text-foreground" : "text-muted-foreground hover:bg-state-hover",
                )}
              >
                <StatusDot status={device.status} />
                <span className="truncate">{device.name}</span>
              </button>
            ))}
            <button
              type="button"
              role="tab"
              aria-selected={showManager}
              onClick={() => setSelected(MANAGER)}
              className={cn(
                "h-7 shrink-0 rounded-md px-2 text-xs",
                showManager ? "bg-state-active text-foreground" : "text-muted-foreground hover:bg-state-hover",
              )}
            >
              Devices
            </button>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ToolButton icon="add" label="Start or create an emulator" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              {stopped.length > 0 ? <DropdownMenuLabel>Start a device</DropdownMenuLabel> : null}
              {stopped.map((device) => (
                <DropdownMenuItem
                  key={device.id}
                  onSelect={() => {
                    setSelected(device.id);
                    void startDevice(rpc, device);
                  }}
                >
                  {device.name}
                  <span className="ml-auto pl-3 text-xs text-muted-foreground">API {device.apiLevel}</span>
                </DropdownMenuItem>
              ))}
              {stopped.length > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onSelect={() => setCreateOpen(true)}>Create device…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSelected(MANAGER)}>Device manager</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {state === null ? (
          <p className="p-4 text-sm text-muted-foreground">Looking for emulators…</p>
        ) : showManager ? (
          <DeviceManager
            devices={devices}
            sdkError={state.sdkError}
            onOpen={setSelected}
            onCreate={() => setCreateOpen(true)}
          />
        ) : active.status === "starting" ? (
          <p className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">Starting {active.name}…</p>
        ) : (
          <>
            <Toolbar device={active} send={send} mouseMode={mouseMode} onMouseModeChange={setMouseMode} />
            <div className="flex min-h-0 flex-1 p-3">
              <Screen
                key={active.id}
                avdId={active.id}
                mouseMode={mouseMode}
                onSendReady={onSendReady}
                onPasteNonAscii={(text) => {
                  rpc.call("pasteText", { avdId: active.id, text }).then(
                    () => toast.message("Copied to the device clipboard. Long-press a text field to paste."),
                    reportError,
                  );
                }}
              />
            </div>
          </>
        )}
        <CreateDeviceDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={setSelected} />
      </div>
    </TooltipProvider>
  );
}
