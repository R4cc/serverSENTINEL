import type { FileEntry } from '../types';
import { fileIconKind } from '../utils/files';
import {
  ArchiveRestore,
  ArrowRightLeft,
  ArrowUp,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  FileSliders,
  FileUp,
  Folder,
  FolderPlus,
  Gauge,
  GripHorizontal,
  Hourglass,
  House,
  MoreHorizontal,
  MoreVertical,
  Network,
  Pencil,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Server,
  Settings,
  Shield,
  SquareTerminal,
  Trash2,
  Type,
  X,
  type LucideIcon
} from 'lucide-react';

type SidebarIconName = "overview" | "console" | "files" | "mods" | "schedule" | "properties" | "settings" | "nodes";

const sidebarIcons: Record<SidebarIconName, LucideIcon> = {
  nodes: Network,
  overview: Gauge,
  console: SquareTerminal,
  files: Folder,
  mods: Puzzle,
  schedule: CalendarDays,
  properties: FileSliders,
  settings: Settings
};

export function SidebarIcon({ name }: { name: SidebarIconName }) {
  const Icon = sidebarIcons[name];
  return <Icon className="sideIcon" aria-hidden="true" />;
}

type AppIconName = "chevronLeft" | "chevronRight" | "chevronUp" | "chevronDown" | "plus" | "x" | "fileUp" | "arrowUp" | "home" | "refresh" | "download" | "folderPlus" | "edit" | "trash" | "copy" | "rename" | "check" | "server" | "search" | "shield" | "hourglass" | "switch" | "extract" | "drag" | "moreHorizontal" | "moreVertical";

const appIcons: Record<AppIconName, LucideIcon> = {
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  chevronUp: ChevronUp,
  chevronDown: ChevronDown,
  plus: Plus,
  x: X,
  fileUp: FileUp,
  arrowUp: ArrowUp,
  home: House,
  refresh: RefreshCw,
  download: Download,
  folderPlus: FolderPlus,
  edit: Pencil,
  trash: Trash2,
  copy: Copy,
  rename: Type,
  check: Check,
  server: Server,
  search: Search,
  shield: Shield,
  hourglass: Hourglass,
  switch: ArrowRightLeft,
  extract: ArchiveRestore,
  drag: GripHorizontal,
  moreHorizontal: MoreHorizontal,
  moreVertical: MoreVertical
};

export function AppIcon({ name }: { name: AppIconName }) {
  const Icon = appIcons[name];
  return <Icon className="buttonIcon" aria-hidden="true" />;
}

export function FileTypeIcon({ entry }: { entry: FileEntry }) {
  const kind = fileIconKind(entry);
  return (
    <span className={`fileTypeIcon ${kind}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {kind === "folder" && (
          <>
            <path d="M3 7.5h6l2 2h10v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            <path d="M3 7.5V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1.5" />
          </>
        )}
        {kind !== "folder" && (
          <>
            <path d="M6 3h8l4 4v14H6Z" />
            <path d="M14 3v5h4" />
          </>
        )}
        {kind === "jar" && (
          <>
            <path d="M9 12h6" />
            <path d="M9 15h6" />
            <path d="M10 18h4" />
          </>
        )}
        {kind === "text" && (
          <>
            <path d="M9 12h6" />
            <path d="M9 15h5" />
            <path d="M9 18h6" />
          </>
        )}
        {kind === "config" && (
          <>
            <circle cx="12" cy="15" r="2.5" />
            <path d="M12 11v-1.5" />
            <path d="M12 20.5V19" />
            <path d="M8.1 12.7 7 11.6" />
            <path d="m17 18.4-1.1-1.1" />
            <path d="m15.9 12.7 1.1-1.1" />
            <path d="M7 18.4 8.1 17.3" />
          </>
        )}
        {kind === "archive" && (
          <>
            <path d="M10 8h3" />
            <path d="M11 8v3" />
            <path d="M10 11h3v3h-3z" />
            <path d="M11.5 14v4" />
          </>
        )}
      </svg>
      {kind === "jar" && <span>JAR</span>}
    </span>
  );
}

export function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <>
      <span className="sidebarToggleIconDesktop" aria-hidden="true">
        <AppIcon name={collapsed ? "chevronRight" : "chevronLeft"} />
      </span>
      <span className="sidebarToggleIconMobile" aria-hidden="true">
        <AppIcon name={collapsed ? "chevronDown" : "chevronUp"} />
      </span>
    </>
  );
}
