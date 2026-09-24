import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, experimental_Diff as Diff, Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";
import type { DiffFile, Scope } from "./contract";
import "./app.css";

const filters: { value: Scope; label: string }[] = [
  { value: "last-turn", label: "Last Turn" },
  { value: "uncommitted", label: "Uncommitted" },
  { value: "unstaged", label: "Unstaged" },
  { value: "staged", label: "Staged" },
  { value: "committed", label: "Committed" },
  { value: "branch", label: "Branch" },
];

function isMarkdown(path: string) {
  return /\.(md|markdown|mdown|mdx)$/iu.test(path);
}

function FileCard({ file }: { file: DiffFile }) {
  const [preview, setPreview] = useState(false);
  const canPreview = isMarkdown(file.path) && file.preview !== null;
  return (
    <section className="tdv-file">
      <header className="tdv-file-header">
        <span className="tdv-path" title={file.path}>{file.path}</span>
        {canPreview && (
          <div className="tdv-toggle" aria-label={"View for " + file.path}>
            <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>Code</button>
            <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button>
          </div>
        )}
      </header>
      {preview && canPreview ? (
        <div className="tdv-markdown"><Markdown content={file.preview ?? ""} /></div>
      ) : file.patch ? (
        <div className="tdv-patch"><Diff patch={file.patch} path={file.path} overflow="scroll" /></div>
      ) : (
        <p className="tdv-note">No text patch is available for this file.</p>
      )}
      {file.truncated && <p className="tdv-note">Patch clipped at 75 KB.</p>}
    </section>
  );
}

function ThreadDiffPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [scope, setScope] = useState<Scope>("last-turn");
  const [menuOpen, setMenuOpen] = useState(false);
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestNumber = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requestNumber.current;
    try {
      const result = await rpc.call("changes", { threadId, scope });
      if (request !== requestNumber.current) return;
      setFiles(result.files);
      setMessage(result.message);
      setError(null);
    } catch (cause) {
      if (request !== requestNumber.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setFiles([]);
    }
  }, [rpc, threadId, scope]);

  useEffect(() => {
    setFiles(null);
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      clearInterval(timer);
      requestNumber.current += 1;
    };
  }, [refresh]);

  const selected = filters.find((filter) => filter.value === scope)?.label ?? "Last Turn";
  return (
    <div className="tdv-root">
      <div className="tdv-toolbar">
        <div className="tdv-filter-wrap">
          <button type="button" className="tdv-filter-button" aria-expanded={menuOpen}
            aria-haspopup="menu" onClick={() => setMenuOpen(!menuOpen)}>
            <span>{selected}</span><span aria-hidden="true">⌄</span>
          </button>
          {menuOpen && (
            <div role="menu" className="tdv-menu">
              {filters.map((filter, index) => (
                <button type="button" role="menuitemradio" aria-checked={scope === filter.value}
                  className={index === 4 ? "tdv-menu-separator" : undefined}
                  key={filter.value}
                  onClick={() => { setScope(filter.value); setMenuOpen(false); }}>
                  <span>{filter.label}</span>
                  <span aria-hidden="true">{scope === filter.value ? "✓" : ""}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="tdv-refresh" onClick={() => void refresh()} aria-label="Refresh changes">↻</button>
      </div>
      <div className="tdv-content">
        {error && <p role="alert" className="tdv-error">{error}</p>}
        {message && <p className="tdv-note">{message}</p>}
        {files === null ? <p className="tdv-note">Loading changes…</p>
          : files.length === 0 && !error ? <p className="tdv-note">No changes in {selected.toLowerCase()}.</p>
          : files.map((file, index) => <FileCard key={file.path + ":" + index} file={file} />)}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "diff-viewer",
    title: "Thread changes",
    icon: "FileDiff",
    layout: "flush",
    component: ThreadDiffPanel,
  });
});
