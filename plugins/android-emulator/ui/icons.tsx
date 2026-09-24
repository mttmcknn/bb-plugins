import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowLeft01Icon,
  Camera01Icon,
  CircleIcon,
  Copy01Icon,
  Delete02Icon,
  Download04Icon,
  File01Icon,
  Folder01Icon,
  HistoryIcon,
  KeyboardIcon,
  Loading03Icon,
  MoreVerticalIcon,
  PlayIcon,
  PowerIcon,
  Refresh01Icon,
  Settings02Icon,
  SmartPhone01Icon,
  SquareIcon,
  StopIcon,
  Upload04Icon,
  VolumeHighIcon,
  VolumeLowIcon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";

const icons = {
  add: Add01Icon,
  arrowLeft: ArrowLeft01Icon,
  camera: Camera01Icon,
  copy: Copy01Icon,
  delete: Delete02Icon,
  device: SmartPhone01Icon,
  download: Download04Icon,
  file: File01Icon,
  folder: Folder01Icon,
  home: CircleIcon,
  keyboard: KeyboardIcon,
  loading: Loading03Icon,
  more: MoreVerticalIcon,
  overview: SquareIcon,
  play: PlayIcon,
  power: PowerIcon,
  refresh: Refresh01Icon,
  settings: Settings02Icon,
  snapshots: HistoryIcon,
  stop: StopIcon,
  upload: Upload04Icon,
  volumeDown: VolumeLowIcon,
  volumeUp: VolumeHighIcon,
} satisfies Record<string, IconSvgElement>;

/** Android Studio-style glyphs with no close hugeicons equivalent. */
const custom = {
  back: <path d="M16 5.5v13L6 12z" />,
  record: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" />
    </>
  ),
  // A phone with an arrow curving around its top corner.
  rotateLeft: (
    <>
      <rect x="9" y="7" width="9" height="13" rx="1.5" />
      <path d="M6 13V9.5A4.5 4.5 0 0 1 10.5 5H13" />
      <path d="M4 11l2 2.5L8 11" />
    </>
  ),
  rotateRight: (
    <>
      <rect x="6" y="7" width="9" height="13" rx="1.5" />
      <path d="M18 13V9.5A4.5 4.5 0 0 0 13.5 5H11" />
      <path d="M16 11l2 2.5 2-2.5" />
    </>
  ),
};

export type IconName = keyof typeof icons | keyof typeof custom;

export function Glyph({ name, className }: { name: IconName; className?: string }) {
  const classes = cn("size-4 shrink-0", name === "loading" && "animate-spin", className);
  if (name in custom) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={classes}
        aria-hidden
      >
        {custom[name as keyof typeof custom]}
      </svg>
    );
  }
  return <HugeiconsIcon icon={icons[name as keyof typeof icons]} strokeWidth={1.6} className={classes} aria-hidden />;
}
