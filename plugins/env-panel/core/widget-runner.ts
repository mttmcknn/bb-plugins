// Loads sub-plugin widgets for a thread: executable scripts in the widgets
// folder, and bb plugins that publish `env-panel.widgets.v1.render`. Every
// source is bounded (time, output size, count) and cached for its refresh
// interval, and one failing widget only fails its own tile.
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { cached, run } from "./cli.ts";
import {
  isWidgetScriptName,
  parseScriptMeta,
  parseWidgetOutput,
  WIDGET_TEMPLATES,
  widgetNameFromFile,
  widgetOutputSchema,
  type Widget,
  type WidgetOutput,
} from "./widgets.ts";

/** Where script widgets live. One executable file per widget. */
export const WIDGET_DIR = join(homedir(), ".config", "bb-env-panel", "widgets");

/** The RPC method another bb plugin publishes to contribute widgets. */
export const WIDGET_RPC_METHOD = "env-panel.widgets.v1.render";

export const widgetRpcInputSchema = z.object({
  threadId: z.string(),
  projectId: z.string(),
  branch: z.string().nullable(),
  worktree: z.string().nullable(),
  pullRequestUrl: z.string().nullable(),
});
export type WidgetContext = z.infer<typeof widgetRpcInputSchema>;

export const widgetRpcOutputSchema = z.object({ widgets: z.array(widgetOutputSchema).max(6) });

const SCRIPT_TIMEOUT_MS = 10_000;
const MAX_SCRIPTS = 20;

export interface WidgetRunnerOptions {
  selfPluginId: string;
  discover(): Promise<{ pluginId: string }[]>;
  callPlugin(pluginId: string, input: WidgetContext): Promise<z.infer<typeof widgetRpcOutputSchema>>;
  log(message: string): void;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface ScriptFile {
  name: string;
  path: string;
  meta: ReturnType<typeof parseScriptMeta>;
}

export function createWidgetRunner(options: WidgetRunnerOptions) {
  const scriptResults = new Map<string, { at: number; widgets: Widget[] }>();
  const running = new Map<string, Promise<Widget[]>>();
  const discovery = cached<{ pluginId: string }[]>(60_000);
  const pluginResults = cached<Widget[]>(30_000);

  async function listScripts(): Promise<ScriptFile[]> {
    let names: string[];
    try {
      names = await readdir(WIDGET_DIR);
    } catch {
      return [];
    }
    const scripts: ScriptFile[] = [];
    for (const name of names.filter(isWidgetScriptName).sort().slice(0, MAX_SCRIPTS)) {
      const path = join(WIDGET_DIR, name);
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        await access(path, constants.X_OK);
      } catch {
        continue; // Not executable: a draft or a data file.
      }
      const head = (await readFile(path, "utf8").catch(() => "")).slice(0, 4_096);
      scripts.push({ name: widgetNameFromFile(name), path, meta: parseScriptMeta(head) });
    }
    return scripts;
  }

  function toWidgets(
    outputs: WidgetOutput[],
    base: Pick<Widget, "source">,
    keyPrefix: string,
    fallbackTitle: string,
    defaultSize: Widget["size"],
  ): Widget[] {
    return outputs.map((output, index) => ({
      ...output,
      title: output.title || fallbackTitle,
      key: `${keyPrefix}:${output.id ?? (outputs.length === 1 ? "main" : String(index))}`,
      size: output.size ?? defaultSize,
      error: null,
      ...base,
    }));
  }

  async function runScript(script: ScriptFile, context: WidgetContext): Promise<Widget[]> {
    const base = { source: { kind: "script" as const, name: script.name } };
    const title = script.meta.title ?? script.name;
    try {
      const stdout = await run(script.path, [], {
        cwd: context.worktree ?? homedir(),
        timeoutMs: SCRIPT_TIMEOUT_MS,
        env: {
          BB_THREAD_ID: context.threadId,
          BB_PROJECT_ID: context.projectId,
          BB_BRANCH: context.branch ?? "",
          BB_WORKTREE: context.worktree ?? "",
          BB_PR_URL: context.pullRequestUrl ?? "",
          BB_PR_NUMBER: /\/pull\/(\d+)/u.exec(context.pullRequestUrl ?? "")?.[1] ?? "",
        },
      });
      const parsed = parseWidgetOutput(stdout.slice(0, 256 * 1024));
      if (!parsed.ok) throw new Error(parsed.error);
      return toWidgets(parsed.widgets, base, `script:${script.name}`, title, script.meta.size ?? "small");
    } catch (error) {
      options.log(`widget ${script.name} failed: ${errorMessage(error)}`);
      return [{ key: `script:${script.name}:main`, title, size: script.meta.size ?? "small", error: errorMessage(error), ...base }];
    }
  }

  /** A script's widgets, rerun once its refresh interval passes. */
  function scriptWidgets(script: ScriptFile, context: WidgetContext, force: boolean): Promise<Widget[]> {
    const key = script.meta.scope === "global" ? script.name : `${script.name}:${context.threadId}`;
    const cachedResult = scriptResults.get(key);
    const fresh = cachedResult !== undefined && Date.now() - cachedResult.at < script.meta.refreshSeconds * 1_000;
    if (fresh && !force) return Promise.resolve(cachedResult.widgets);
    const inFlight = running.get(key);
    if (inFlight !== undefined) return cachedResult ? Promise.resolve(cachedResult.widgets) : inFlight;
    const request = runScript(script, context)
      .then((widgets) => {
        scriptResults.set(key, { at: Date.now(), widgets });
        return widgets;
      })
      .finally(() => running.delete(key));
    running.set(key, request);
    // A stale result keeps showing while the rerun is in flight.
    return cachedResult ? Promise.resolve(cachedResult.widgets) : request;
  }

  async function pluginWidgets(context: WidgetContext, force: boolean): Promise<Widget[]> {
    let providers: { pluginId: string }[];
    try {
      providers = await discovery("providers", options.discover, force);
    } catch (error) {
      options.log(`widget discovery failed: ${errorMessage(error)}`);
      return [];
    }
    const results = await Promise.all(
      providers
        .filter((provider) => provider.pluginId !== options.selfPluginId)
        .map((provider) =>
          pluginResults(
            `${provider.pluginId}:${context.threadId}`,
            async () => {
              const base = { source: { kind: "plugin" as const, pluginId: provider.pluginId } };
              try {
                const output = await options.callPlugin(provider.pluginId, context);
                return toWidgets(output.widgets, base, `plugin:${provider.pluginId}`, provider.pluginId, "small");
              } catch (error) {
                return [
                  { key: `plugin:${provider.pluginId}:main`, title: provider.pluginId, size: "small" as const, error: errorMessage(error), ...base },
                ];
              }
            },
            force,
          ),
        ),
    );
    return results.flat();
  }

  return {
    async load(context: WidgetContext, force = false): Promise<Widget[]> {
      const scripts = await listScripts();
      const [fromScripts, fromPlugins] = await Promise.all([
        Promise.all(scripts.map((script) => scriptWidgets(script, context, force))),
        pluginWidgets(context, force),
      ]);
      return [...fromScripts.flat(), ...fromPlugins];
    },
    listScripts,
  };
}

/** Writes a widget from a template; refuses to overwrite an existing file. */
export async function createWidgetFromTemplate(name: string, templateId: string): Promise<string> {
  const template = WIDGET_TEMPLATES[templateId];
  if (template === undefined) throw new Error(`No template "${templateId}". Templates: ${Object.keys(WIDGET_TEMPLATES).join(", ")}`);
  const extension = /\.[a-z0-9]+$/iu.exec(template.file)?.[0] ?? ".sh";
  const file = `${name}${extension}`;
  if (!isWidgetScriptName(file)) throw new Error("Use letters, digits, dots, dashes, or underscores for the name.");
  await mkdir(WIDGET_DIR, { recursive: true });
  const path = join(WIDGET_DIR, file);
  await writeFile(path, template.source, { mode: 0o755, flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "EEXIST" ? new Error(`${path} already exists.`) : error;
  });
  return path;
}
