// Sub-plugin widgets: the one data format that script widgets and other bb
// plugins use to put tiles in the panel. Pure: schemas, metadata parsing,
// and templates. Running scripts and calling plugins lives in server.ts.
import { z } from "zod";

export const WIDGET_SIZES = ["small", "wide", "large"] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

const tone = z.enum(["neutral", "positive", "warning", "critical", "accent"]);
const url = z.string().url().max(2_000).refine((value) => /^https?:\/\//iu.test(value), "Only http(s) URLs");
const text = (max: number) => z.string().trim().max(max);

const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), label: text(40), url }),
  // Sent to the thread's agent only when the user clicks it.
  z.object({ kind: z.literal("prompt"), label: text(40), prompt: text(2_000) }),
  z.object({ kind: z.literal("copy"), label: text(40), text: text(2_000) }),
]);

/** What a widget reports each time it runs. Every field but `title` is optional. */
export const widgetOutputSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/iu).optional(),
  title: text(60).min(1),
  /** An emoji, or one of WIDGET_ICONS. */
  icon: text(40).optional(),
  size: z.enum(WIDGET_SIZES).optional(),
  /** The big glanceable value: "3", "Green", "+120". */
  value: text(40).optional(),
  caption: text(160).optional(),
  tone: tone.optional(),
  /** 0–1, drawn as a ring on small tiles and a bar on wide ones. */
  progress: z.number().min(0).max(1).optional(),
  url: url.optional(),
  items: z
    .array(z.object({ label: text(160), detail: text(160).optional(), url: url.optional(), tone: tone.optional() }))
    .max(30)
    .optional(),
  actions: z.array(actionSchema).max(4).optional(),
  /** True when the widget has nothing to say right now, such as no devices. */
  hidden: z.boolean().optional(),
});

export type WidgetOutput = z.infer<typeof widgetOutputSchema>;
export type WidgetAction = z.infer<typeof actionSchema>;

/** A widget as the panel renders it: output plus where it came from. */
export interface Widget extends WidgetOutput {
  /** Unique across sources: `script:<name>` or `plugin:<pluginId>:<id>`. */
  key: string;
  source: { kind: "script"; name: string } | { kind: "plugin"; pluginId: string };
  size: WidgetSize;
  /** Set when the last run failed; the tile shows it instead of data. */
  error: string | null;
}

/** Icon names a widget may use, mapped to the panel's icon set. */
export const WIDGET_ICONS = [
  "android",
  "phone",
  "bug",
  "chart",
  "check",
  "clock",
  "cloud",
  "code",
  "database",
  "flag",
  "globe",
  "heart",
  "lightning",
  "link",
  "mail",
  "rocket",
  "server",
  "shield",
  "star",
  "terminal",
  "users",
] as const;

// ---- Script widgets ---------------------------------------------------------

export interface ScriptMeta {
  title: string | null;
  size: WidgetSize | null;
  refreshSeconds: number;
  /** "thread" reruns for every thread; "global" shares one result. */
  scope: "thread" | "global";
}

const DEFAULT_REFRESH_SECONDS = 60;

/**
 * Reads `bb-widget:` settings from a script's first lines, in any comment
 * style: `# bb-widget: refresh=30`, `// bb-widget: size=wide`.
 */
export function parseScriptMeta(source: string): ScriptMeta {
  const meta: ScriptMeta = { title: null, size: null, refreshSeconds: DEFAULT_REFRESH_SECONDS, scope: "thread" };
  for (const line of source.split("\n").slice(0, 30)) {
    const match = /bb-widget:\s*([a-z]+)\s*=\s*(.+?)\s*$/iu.exec(line);
    if (match === null) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!;
    if (key === "title") meta.title = value.slice(0, 60);
    if (key === "size" && (WIDGET_SIZES as readonly string[]).includes(value)) meta.size = value as WidgetSize;
    if (key === "refresh" && /^\d+$/u.test(value)) meta.refreshSeconds = Math.min(3_600, Math.max(5, Number(value)));
    if (key === "scope" && (value === "thread" || value === "global")) meta.scope = value;
  }
  return meta;
}

/** Script file names that are widgets: no dotfiles, backups, or docs. */
export function isWidgetScriptName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(name) && !/\.(md|txt|json|bak|orig|swp)$|~$/iu.test(name);
}

/** The widget name a file contributes: its name without the extension. */
export function widgetNameFromFile(name: string): string {
  return name.replace(/\.[a-z0-9]+$/iu, "");
}

/**
 * Parses what a script printed: one widget object, or `{ "widgets": [...] }`
 * for a script that reports several. Returns a readable error otherwise.
 */
export function parseWidgetOutput(stdout: string): { ok: true; widgets: WidgetOutput[] } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(stdout.trim() || "null");
  } catch {
    return { ok: false, error: "The script did not print JSON." };
  }
  const list = json !== null && typeof json === "object" && "widgets" in json ? (json as { widgets: unknown }).widgets : [json];
  if (!Array.isArray(list) || list.length === 0 || list.length > 6) {
    return { ok: false, error: "Print one widget object, or { \"widgets\": [...] } with up to 6." };
  }
  const widgets: WidgetOutput[] = [];
  for (const entry of list) {
    const parsed = widgetOutputSchema.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { ok: false, error: `Invalid widget: ${issue?.path.join(".") || "value"} ${issue?.message ?? ""}`.trim() };
    }
    widgets.push(parsed.data);
  }
  return { ok: true, widgets };
}

// ---- Templates for `bb env-panel widgets new` --------------------------------

export const WIDGET_TEMPLATES: Record<string, { description: string; file: string; source: string }> = {
  basic: {
    description: "A starting point that shows the thread's branch",
    file: "my-widget.sh",
    source: `#!/bin/sh
# A bb Environment Panel widget. Print one JSON object; see
# \`bb env-panel widgets help\` for every field.
# bb-widget: title=My widget
# bb-widget: size=small
# bb-widget: refresh=60
#
# Available: BB_THREAD_ID, BB_PROJECT_ID, BB_BRANCH, BB_WORKTREE,
# BB_PR_URL, BB_PR_NUMBER. The script runs in the worktree when there is one.

branch="\${BB_BRANCH:-none}"
printf '{"title":"Branch","icon":"code","value":"%s","caption":"%s"}\\n' \\
  "$(printf '%s' "$branch" | cut -c1-12)" "$branch"
`,
  },
  "android-devices": {
    description: "Connected Android devices and emulators, from adb",
    file: "android-devices.sh",
    source: `#!/bin/sh
# Connected Android devices and emulators, from adb.
# bb-widget: title=Devices
# bb-widget: size=wide
# bb-widget: refresh=20
# bb-widget: scope=global

if ! command -v adb >/dev/null 2>&1; then
  echo '{"title":"Devices","icon":"android","hidden":true}'
  exit 0
fi

adb devices -l 2>/dev/null | awk '
  NR == 1 || NF == 0 { next }
  {
    serial = $1; state = $2; model = serial
    for (i = 3; i <= NF; i++) if ($i ~ /^model:/) { model = substr($i, 7); gsub(/_/, " ", model) }
    kind = (serial ~ /^emulator-/) ? "Emulator" : "Device"
    tone = (state == "device") ? "positive" : "warning"
    items = items (n++ ? "," : "") sprintf("{\\"label\\":\\"%s\\",\\"detail\\":\\"%s · %s\\",\\"tone\\":\\"%s\\"}", model, kind, state, tone)
    if (state == "device") ready++
  }
  END {
    caption = (n == 0) ? "Nothing connected" : sprintf("%d ready of %d", ready, n)
    tone = (n == 0) ? "neutral" : (ready == n ? "positive" : "warning")
    printf "{\\"title\\":\\"Devices\\",\\"icon\\":\\"android\\",\\"value\\":\\"%d\\",\\"caption\\":\\"%s\\",\\"tone\\":\\"%s\\",\\"items\\":[%s]}\\n", n, caption, tone, items
  }'
`,
  },
};
