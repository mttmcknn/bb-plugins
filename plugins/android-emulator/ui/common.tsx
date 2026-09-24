import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Glyph, type IconName } from "./icons";

export const PLUGIN_ID = "android-emulator";

export function useEmulatorRpc() {
  return useRpc<typeof rpcContract>();
}

export type EmulatorRpc = ReturnType<typeof useEmulatorRpc>;

function httpPath(route: string, params: Record<string, string>): string {
  return `/api/v1/plugins/${PLUGIN_ID}/http${route}?${new URLSearchParams(params)}`;
}

export function socketUrl(route: string, params: Record<string, string>): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${httpPath(route, params)}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function reportError(error: unknown): void {
  toast.error(errorMessage(error));
}

/** Fetches a plugin GET route and saves the response as a file. */
export async function download(
  route: string,
  params: Record<string, string>,
  fallbackName: string,
): Promise<void> {
  const response = await fetch(httpPath(route, params));
  if (!response.ok) throw new Error((await response.text()) || `Download failed (${response.status})`);
  const disposition = response.headers.get("content-disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Uploads a file over the /upload socket; APKs are installed, others pushed. */
export function upload(avdId: string, file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl("/upload", { avd: avdId, name: file.name }));
    let settled = false;
    socket.onopen = async () => {
      const chunkSize = 1024 * 1024;
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        socket.send(await file.slice(offset, offset + chunkSize).arrayBuffer());
      }
      socket.send(JSON.stringify({ t: "end" }));
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { t: string; message: string };
      settled = true;
      if (message.t === "done") resolve(message.message);
      else reject(new Error(message.message));
    };
    socket.onclose = () => {
      if (!settled) reject(new Error(`Upload of ${file.name} was interrupted.`));
    };
  });
}

type ToolButtonProps = ComponentPropsWithoutRef<"button"> & {
  icon: IconName;
  label: string;
  active?: boolean;
  iconClassName?: string;
};

/** An icon-only toolbar button with a tooltip and an accessible name. */
export const ToolButton = forwardRef<HTMLButtonElement, ToolButtonProps>(
  function ToolButton({ icon, label, active, className, iconClassName, ...props }, ref) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={ref}
            variant="ghost"
            size="icon"
            aria-label={label}
            aria-pressed={active}
            className={cn("size-8 text-muted-foreground hover:text-foreground", className)}
            {...props}
          >
            <Glyph name={icon} className={cn("size-[18px]", iconClassName)} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    );
  },
);

export function ToolDivider() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />;
}
