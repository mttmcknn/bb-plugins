// Attachments: everything a thread refers to, as rich cards. Pure view; the
// host Link, FileLink, Markdown, and Thumbnail components come in through
// PanelActions so this file renders the same in BB and in the preview.
import { useState, type ReactNode } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import CircleIcon from "@hugeicons/core-free-icons/CircleIcon";
import File01Icon from "@hugeicons/core-free-icons/File01Icon";
import FigmaIcon from "@hugeicons/core-free-icons/FigmaIcon";
import GitMergeIcon from "@hugeicons/core-free-icons/GitMergeIcon";
import GitPullRequestClosedIcon from "@hugeicons/core-free-icons/GitPullRequestClosedIcon";
import GitPullRequestDraftIcon from "@hugeicons/core-free-icons/GitPullRequestDraftIcon";
import GitPullRequestIcon from "@hugeicons/core-free-icons/GitPullRequestIcon";
import GithubIcon from "@hugeicons/core-free-icons/GithubIcon";
import Image01Icon from "@hugeicons/core-free-icons/Image01Icon";
import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import Loading03Icon from "@hugeicons/core-free-icons/Loading03Icon";
import NotionIcon from "@hugeicons/core-free-icons/Notion01Icon";
import SlackIcon from "@hugeicons/core-free-icons/SlackIcon";
import Task01Icon from "@hugeicons/core-free-icons/Task01Icon";
import TaskDone01Icon from "@hugeicons/core-free-icons/TaskDone01Icon";
import { cn } from "@/lib/utils";
import type { Attachment, AttachmentKind, AttachmentsInfo, GithubItem, LinearIssue, NotionPage, Section, WebPreview } from "../core/types.ts";
import type { PanelActions } from "./panel";
import { CollapsibleSection } from "./section";

// ---- Small pieces -------------------------------------------------------

function Glyph({ icon, className }: { icon: IconSvgElement; className?: string }) {
  return <HugeiconsIcon icon={icon} className={cn("size-4 shrink-0", className)} strokeWidth={1.8} />;
}

export function relativeDate(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 30 * 86_400) return `${Math.round(seconds / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A colored dot for data-driven colors such as Linear states and labels. */
function Dot({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", className)} style={{ backgroundColor: color }} />;
}

function Chip({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <span className="inline-flex h-5 max-w-full items-center gap-1 rounded-full border border-border px-1.5 text-[11px] text-muted-foreground">
      {color ? <Dot color={color} className="size-1.5" /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

function Avatar({ url, name, actions }: { url: string | null; name: string; actions: PanelActions }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {url ? (
        <actions.Thumbnail source={{ kind: "url", url }} alt="" className="size-4 shrink-0 rounded-full" />
      ) : null}
      <span className="truncate">{name}</span>
    </span>
  );
}

/** One card's shell: an icon, a linked title line, and optional detail below. */
function Card({
  href,
  icon,
  title,
  meta,
  children,
  actions,
  expandable,
}: {
  href: string;
  icon: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  actions: PanelActions;
  expandable?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg px-1.5 py-1.5 hover:bg-accent/50">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">{icon}</span>
        <div className="min-w-0 flex-1">
          <actions.Link href={href} className="block truncate text-sm hover:underline" title={typeof title === "string" ? title : undefined}>
            {title}
          </actions.Link>
          {meta ? <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">{meta}</div> : null}
          {children}
          {open ? <div className="mt-1.5">{expandable}</div> : null}
        </div>
        {expandable ? (
          <button
            type="button"
            aria-label={open ? "Hide details" : "Show details"}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Glyph icon={open ? ArrowDown01Icon : ArrowRight01Icon} className="size-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Excerpt({ text }: { text: string | null }) {
  if (text === null) return null;
  return <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{text}</p>;
}

// ---- Linear -------------------------------------------------------------

const PRIORITY_BARS: Record<number, string> = { 1: "!!!", 2: "▮▮▮", 3: "▮▮▯", 4: "▮▯▯" };

function stateGlyph(type: string | null): { icon: IconSvgElement; className: string } {
  if (type === "completed") return { icon: TaskDone01Icon, className: "text-success" };
  if (type === "canceled") return { icon: TaskDone01Icon, className: "text-muted-foreground" };
  if (type === "started") return { icon: Task01Icon, className: "text-warning" };
  return { icon: CircleIcon, className: "text-muted-foreground" };
}

/** Linear descriptions embed images that need a Linear session; drop them. */
function withoutPrivateImages(markdown: string): string {
  return markdown.replace(/!\[[^\]]*\]\([^)]*\)/gu, "").replace(/\n{3,}/gu, "\n\n").trim();
}

function LinearCard({ issue, actions }: { issue: LinearIssue; actions: PanelActions }) {
  const details = [issue.project, issue.cycle, issue.estimate === null ? null : `${issue.estimate} pt`, issue.dueDate ? `due ${issue.dueDate}` : null].filter(Boolean);
  const hasMore = issue.description !== null || issue.children.length > 0 || issue.links.length > 0;
  return (
    <Card
      href={issue.url}
      actions={actions}
      icon={issue.state ? <Dot color={issue.state.color} className="size-2.5" /> : <Glyph icon={Task01Icon} className="text-muted-foreground" />}
      title={
        <>
          <span className="text-muted-foreground">{issue.identifier}</span> {issue.title}
        </>
      }
      meta={
        <>
          {issue.state ? <span className="text-foreground/80">{issue.state.name}</span> : null}
          {issue.priority > 0 ? (
            <span title={issue.priorityLabel} className={cn("font-mono tracking-tighter", issue.priority === 1 && "text-destructive")}>
              {PRIORITY_BARS[issue.priority]}
            </span>
          ) : null}
          {issue.assignee ? <Avatar url={issue.assignee.avatarUrl} name={issue.assignee.name} actions={actions} /> : <span>Unassigned</span>}
          <span>{relativeDate(issue.updatedAt)}</span>
        </>
      }
      expandable={
        hasMore ? (
          <div className="space-y-2 text-xs">
            {details.length > 0 ? <div className="text-muted-foreground">{details.join(" · ")}</div> : null}
            {issue.description ? (
              <div className="max-h-72 overflow-y-auto rounded-md border border-border bg-background/60 px-2.5 py-2 text-[13px]">
                <actions.Markdown content={withoutPrivateImages(issue.description)} />
              </div>
            ) : null}
            {issue.children.length > 0 ? (
              <div>
                <div className="mb-0.5 font-medium text-muted-foreground">Sub-issues</div>
                {issue.children.map((child) => {
                  const glyph = stateGlyph(child.stateType);
                  return (
                    <div key={child.identifier} className="flex items-center gap-1.5 py-0.5">
                      <Glyph icon={glyph.icon} className={cn("size-3.5", glyph.className)} />
                      <span className="text-muted-foreground">{child.identifier}</span>
                      <span className="truncate">{child.title}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {issue.links.length > 0 ? (
              <div>
                <div className="mb-0.5 font-medium text-muted-foreground">Linked</div>
                {issue.links.map((link) => (
                  <actions.Link key={link.url} href={link.url} className="block truncate py-0.5 hover:underline">
                    {link.title}
                  </actions.Link>
                ))}
              </div>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {issue.labels.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {issue.labels.slice(0, 5).map((label) => (
            <Chip key={label.name} color={label.color}>
              {label.name}
            </Chip>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

// ---- Notion, GitHub, web ---------------------------------------------------

function NotionCard({ page, actions }: { page: NotionPage; actions: PanelActions }) {
  const icon =
    page.icon === null ? (
      <Glyph icon={NotionIcon} className="text-muted-foreground" />
    ) : "emoji" in page.icon ? (
      <span className="text-sm leading-none">{page.icon.emoji}</span>
    ) : (
      <actions.Thumbnail source={{ kind: "url", url: page.icon.imageUrl }} alt="" className="size-4 rounded-sm" />
    );
  return (
    <Card href={page.url} actions={actions} icon={icon} title={page.title} meta={<span>Notion · edited {relativeDate(page.lastEditedAt)}</span>}>
      <Excerpt text={page.excerpt} />
    </Card>
  );
}

function githubGlyph(item: GithubItem, isPull: boolean): { icon: IconSvgElement; className: string } {
  if (!isPull) return { icon: GithubIcon, className: item.state === "closed" ? "text-primary" : "text-success" };
  switch (item.state) {
    case "merged":
      return { icon: GitMergeIcon, className: "text-primary" };
    case "closed":
      return { icon: GitPullRequestClosedIcon, className: "text-destructive" };
    case "draft":
      return { icon: GitPullRequestDraftIcon, className: "text-muted-foreground" };
    default:
      return { icon: GitPullRequestIcon, className: "text-success" };
  }
}

function GithubCard({ attachment, item, actions }: { attachment: Attachment & { ref: { kind: "github" } }; item: GithubItem; actions: PanelActions }) {
  const glyph = githubGlyph(item, attachment.ref.isPull);
  return (
    <Card
      href={attachment.ref.url}
      actions={actions}
      icon={<Glyph icon={glyph.icon} className={glyph.className} />}
      title={
        <>
          <span className="text-muted-foreground">{attachment.ref.label}</span> {item.title}
        </>
      }
      meta={
        <>
          <span className="capitalize">{item.state}</span>
          {item.author ? <Avatar url={item.author.avatarUrl} name={item.author.login} actions={actions} /> : null}
          {item.comments > 0 ? <span>{item.comments} comments</span> : null}
          <span>{relativeDate(item.updatedAt)}</span>
        </>
      }
      expandable={item.excerpt ? <p className="whitespace-pre-line text-xs text-muted-foreground">{item.excerpt}</p> : undefined}
    >
      {item.labels.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {item.labels.slice(0, 4).map((label) => (
            <Chip key={label.name} color={label.color}>
              {label.name}
            </Chip>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
}

function WebCard({ url, preview, actions }: { url: string; preview: WebPreview; actions: PanelActions }) {
  return (
    <actions.Link href={url} className="block rounded-lg px-1.5 py-1.5 hover:bg-accent/50" title={url}>
      <div className="flex gap-2.5">
        {preview.imageUrl ? (
          <actions.Thumbnail source={{ kind: "url", url: preview.imageUrl }} alt="" className="size-12 shrink-0 rounded-md border border-border object-cover" />
        ) : (
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
            <Glyph icon={Link01Icon} className="text-muted-foreground" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">{preview.title ?? hostOf(url)}</div>
          <div className="truncate text-xs text-muted-foreground">{preview.siteName ?? hostOf(url)}</div>
          {preview.description ? <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{preview.description}</p> : null}
        </div>
      </div>
    </actions.Link>
  );
}

function PlainRow({ href, icon, label, hint, pending, actions }: { href: string; icon: IconSvgElement; label: string; hint?: string | null; pending?: boolean; actions: PanelActions }) {
  return (
    <actions.Link href={href} className="block rounded-lg px-1.5 py-1.5 hover:bg-accent/50" title={href}>
      <div className="flex items-center gap-2.5 text-sm">
        <Glyph icon={pending ? Loading03Icon : icon} className={cn("text-muted-foreground", pending && "animate-spin")} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </div>
      {hint ? <p className="ml-6.5 mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </actions.Link>
  );
}

function AttachmentCard({ attachment, pending, actions }: { attachment: Attachment; pending: boolean; actions: PanelActions }) {
  const { ref, detail, hint } = attachment;
  if (detail?.kind === "linear") return <LinearCard issue={detail.issue} actions={actions} />;
  if (detail?.kind === "notion") return <NotionCard page={detail.page} actions={actions} />;
  if (detail?.kind === "github" && ref.kind === "github") return <GithubCard attachment={{ ...attachment, ref }} item={detail.item} actions={actions} />;
  if (detail?.kind === "web" && ref.url) return <WebCard url={ref.url} preview={detail.preview} actions={actions} />;
  if (ref.kind === "file") {
    return (
      <actions.FileLink path={ref.path} className="block rounded-lg px-1.5 py-1.5 hover:bg-accent/50">
        <div className="flex items-center gap-2.5 text-sm" title={ref.path}>
          <Glyph icon={File01Icon} className="text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{ref.label}</span>
        </div>
      </actions.FileLink>
    );
  }
  const icon: Partial<Record<AttachmentKind, IconSvgElement>> = {
    linear: Task01Icon,
    notion: NotionIcon,
    github: GithubIcon,
    figma: FigmaIcon,
    slack: SlackIcon,
  };
  return <PlainRow href={ref.url ?? "#"} icon={icon[ref.kind] ?? Link01Icon} label={ref.label} hint={hint} pending={pending && detail === null} actions={actions} />;
}

// ---- Images -------------------------------------------------------------

/** A stored file's path, or null for references that only have a URL. */
function storagePath(ref: Attachment["ref"]): string | null {
  return "path" in ref && ref.path !== undefined ? ref.path : null;
}

function ImageGrid({ images, actions }: { images: Attachment[]; actions: PanelActions }) {
  return (
    <div className="grid grid-cols-3 gap-1.5 px-1.5 py-1">
      {images.map(({ ref }) => {
        const path = storagePath(ref);
        const url = ref.url ?? "";
        const tile = (
          <div className="group relative aspect-square overflow-hidden rounded-md border border-border bg-muted" title={ref.label}>
            <actions.Thumbnail
              source={path !== null ? { kind: "file", path } : { kind: "url", url }}
              alt={ref.label}
              className="size-full object-cover"
              fallback={<Glyph icon={Image01Icon} className="m-auto size-5 text-muted-foreground" />}
            />
            <span className="absolute inset-x-0 bottom-0 truncate bg-background/80 px-1 py-0.5 text-[10px] opacity-0 transition-opacity group-hover:opacity-100">
              {ref.label}
            </span>
          </div>
        );
        return path !== null ? (
          <actions.FileLink key={ref.id} path={path} className="block">
            {tile}
          </actions.FileLink>
        ) : (
          <actions.Link key={ref.id} href={url} className="block">
            {tile}
          </actions.Link>
        );
      })}
    </div>
  );
}

// ---- Section ------------------------------------------------------------

type Filter = "all" | "tickets" | "docs" | "code" | "links" | "media" | "files";

const FILTERS: { id: Filter; label: string; kinds: AttachmentKind[] }[] = [
  { id: "all", label: "All", kinds: [] },
  { id: "tickets", label: "Tickets", kinds: ["linear"] },
  { id: "docs", label: "Docs", kinds: ["notion", "figma"] },
  { id: "code", label: "Code", kinds: ["github"] },
  { id: "links", label: "Links", kinds: ["web", "slack"] },
  { id: "media", label: "Media", kinds: ["image"] },
  { id: "files", label: "Files", kinds: ["file"] },
];

const SINGULAR: Record<string, string> = { Tickets: "ticket", Docs: "doc", Code: "code link", Links: "link", Media: "image", Files: "file" };

// Richest first: tickets and docs lead, plain files trail.
const KIND_ORDER: AttachmentKind[] = ["linear", "notion", "figma", "github", "web", "slack", "file"];
const COLLAPSED_CARDS = 6;

export function AttachmentsSection({
  attachments,
  actions,
  title = "Attachments",
}: {
  attachments: Section<AttachmentsInfo>;
  actions: PanelActions;
  title?: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState(false);
  if (!attachments.ok) {
    return (
      <CollapsibleSection id="attachments" title={title}>
        <p className="px-1.5 py-1 text-xs text-destructive">{attachments.error}</p>
      </CollapsibleSection>
    );
  }
  const { items, enriching } = attachments.value;
  if (items.length === 0) return null;

  const available = FILTERS.filter((entry) => entry.id === "all" || items.some((item) => entry.kinds.includes(item.ref.kind)));
  const active = available.find((entry) => entry.id === filter) ?? FILTERS[0]!;
  const visible = active.id === "all" ? items : items.filter((item) => active.kinds.includes(item.ref.kind));
  const images = visible.filter((item) => item.ref.kind === "image");
  const cards = visible
    .filter((item) => item.ref.kind !== "image")
    .sort((a, b) => KIND_ORDER.indexOf(a.ref.kind) - KIND_ORDER.indexOf(b.ref.kind));
  const shownCards = expanded ? cards : cards.slice(0, COLLAPSED_CARDS);

  const summary = FILTERS.filter((entry) => entry.id !== "all")
    .map((entry) => [entry.label, items.filter((item) => entry.kinds.includes(item.ref.kind)).length] as const)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${count === 1 ? SINGULAR[label] ?? label.toLowerCase() : label.toLowerCase()}`)
    .join(" · ");
  return (
    <CollapsibleSection
      id="attachments"
      title={title}
      count={items.length}
      summary={summary}
      trailing={enriching ? <Glyph icon={Loading03Icon} className="size-3 animate-spin" /> : null}
    >
      {items.length >= 5 && available.length > 2 ? (
        <div className="flex flex-wrap gap-1 px-1 pb-1.5" role="tablist" aria-label="Filter attachments">
          {available.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={entry.id === active.id}
              onClick={() => {
                setFilter(entry.id);
                setExpanded(false);
              }}
              className={cn(
                "h-6 rounded-full border px-2 text-xs transition-colors",
                entry.id === active.id ? "border-transparent bg-accent text-foreground" : "border-border text-muted-foreground hover:bg-accent/60",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}
      {shownCards.map((item) => (
        <AttachmentCard key={item.ref.id} attachment={item} pending={enriching} actions={actions} />
      ))}
      {cards.length > COLLAPSED_CARDS ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex min-h-7 w-full items-center rounded-md px-1.5 pl-8 text-sm text-muted-foreground hover:bg-accent"
        >
          {expanded ? "Show less" : `View all (${cards.length - COLLAPSED_CARDS} more)`}
        </button>
      ) : null}
      {images.length > 0 ? <ImageGrid images={images} actions={actions} /> : null}
    </CollapsibleSection>
  );
}
