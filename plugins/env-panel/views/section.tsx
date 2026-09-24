// Shared section chrome: collapsible sections that remember their state, and
// stable identicons for subagents.
import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import { cn } from "@/lib/utils";

// ---- Collapsed state, shared by the panel and Thread info -----------------

const COLLAPSED_KEY = "bb-env-panel:collapsed";
const listeners = new Set<() => void>();

function readCollapsed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

let collapsed = typeof localStorage === "undefined" ? new Set<string>() : readCollapsed();

function setCollapsed(id: string, value: boolean) {
  const next = new Set(collapsed);
  if (value) next.add(id);
  else next.delete(id);
  collapsed = next;
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
  } catch {
    // Private mode or a full quota: keep the state for this session only.
  }
  for (const listener of listeners) listener();
}

/** Whether section `id` is collapsed, remembered across reloads. */
export function useCollapsed(id: string): [boolean, (value: boolean) => void] {
  const isCollapsed = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => collapsed.has(id),
  );
  return [isCollapsed, (value) => setCollapsed(id, value)];
}

// ---- Section --------------------------------------------------------------

/**
 * "plain" drops section headers and dividers: a tile's detail view already
 * names what it shows, so its sections render as bare content.
 */
export const SectionChrome = createContext<"collapsible" | "plain">("collapsible");

export function Divider() {
  return <div className="mx-1 my-2 border-t border-border" />;
}

/**
 * A titled section whose body can be minimized. `summary` renders beside the
 * title while collapsed, so a minimized section still says what is in it.
 */
export function CollapsibleSection({
  id,
  title,
  count,
  trailing,
  summary,
  divider = true,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  trailing?: ReactNode;
  summary?: ReactNode;
  divider?: boolean;
  children: ReactNode;
}) {
  const chrome = useContext(SectionChrome);
  const [isCollapsed, setIsCollapsed] = useCollapsed(id);
  const bodyId = `env-panel-section-${id}`;
  if (chrome === "plain") return <>{children}</>;
  return (
    <>
      {divider ? <Divider /> : null}
      <div className="flex items-center gap-1 px-1 pb-1 pt-1 text-xs font-medium text-muted-foreground">
        <button
          type="button"
          aria-expanded={!isCollapsed}
          aria-controls={bodyId}
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="group -ml-1 flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left hover:text-foreground"
        >
          <span className="truncate">{title}</span>
          {count === undefined ? null : <span className="tabular-nums opacity-70">{count}</span>}
          <HugeiconsIcon
            icon={isCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
            className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            strokeWidth={2}
          />
          {isCollapsed && summary ? <span className="ml-1 min-w-0 truncate font-normal">{summary}</span> : null}
        </button>
        {isCollapsed ? null : trailing}
      </div>
      <div id={bodyId} hidden={isCollapsed}>
        {isCollapsed ? null : children}
      </div>
    </>
  );
}

// ---- Identicons -------------------------------------------------------------

/** FNV-1a, so the same subagent always draws the same identicon. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

// Theme tokens only, so identicons follow custom palettes.
const TONES = ["text-primary", "text-success", "text-warning", "text-destructive", "text-foreground/70"];

/** A mirrored 5×5 pattern derived from `seed`, drawn in one theme color. */
export function Identicon({ seed, className, title }: { seed: string; className?: string; title?: string }) {
  const value = hash(seed);
  const cells: ReactNode[] = [];
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      if (((value >>> (row * 3 + column)) & 1) === 0) continue;
      cells.push(<rect key={`${row}-${column}`} x={column} y={row} width={1} height={1} />);
      if (column < 2) cells.push(<rect key={`${row}-${4 - column}`} x={4 - column} y={row} width={1} height={1} />);
    }
  }
  return (
    <span
      title={title}
      className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-muted ring-2 ring-popover", TONES[value % TONES.length], className)}
    >
      <svg viewBox="-0.5 -0.5 6 6" className="size-3.5" fill="currentColor" aria-hidden>
        {cells}
      </svg>
    </span>
  );
}

/** "42s", "3m", "1h 5m": how long something ran. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Local toggle state for "Show all" lists inside a section. */
export function useToggle(initial = false): [boolean, () => void] {
  const [value, setValue] = useState(initial);
  return [value, () => setValue((current) => !current)];
}
