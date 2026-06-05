import type { FileEntry } from '../types';
import { fileIconKind } from '../utils/files';

export function SidebarIcon({ name }: { name: "overview" | "console" | "files" | "mods" | "schedule" | "properties" | "settings" | "nodes" }) {
  if (name === "nodes") {
    return (
      <svg className="sideIcon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="6" r="2.5" />
        <circle cx="6" cy="17" r="2.5" />
        <circle cx="18" cy="17" r="2.5" />
        <path d="m11 8.5-4 6" />
        <path d="m13 8.5 4 6" />
        <path d="M8.5 17h7" />
      </svg>
    );
  }
  if (name === "overview") {
    return (
      <svg className="sideIcon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="5" width="16" height="4" rx="1.5" />
        <rect x="4" y="10" width="16" height="4" rx="1.5" />
        <rect x="4" y="15" width="16" height="4" rx="1.5" />
        <circle cx="7" cy="7" r="0.8" />
        <circle cx="7" cy="12" r="0.8" />
        <circle cx="7" cy="17" r="0.8" />
      </svg>
    );
  }
  if (name === "console") {
    return (
      <svg className="sideIcon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 5h16v14H4z" />
        <path d="m8 10 3 2-3 2" />
        <path d="M13 15h4" />
      </svg>
    );
  }
  if (name === "files") {
    return (
      <svg className="sideIcon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 7h7l2 2h9v10H3z" />
        <path d="M3 7V5h7l2 2" />
      </svg>
    );
  }
  if (name === "mods") {
    return (
      <svg className="sideIcon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 3h8v4h4v10h-4v4H8v-4H4V7h4z" />
        <path d="M10 10h4" />
        <path d="M10 14h4" />
      </svg>
    );
  }
  if (name === "schedule") {
    return (
      <svg className="sideIcon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="5" width="16" height="15" rx="1.5" />
        <path d="M8 3v4" />
        <path d="M16 3v4" />
        <path d="M4 10h16" />
        <path d="M9 15h3l2-2" />
      </svg>
    );
  }
  if (name === "properties") {
    return (
      <svg className="sideIcon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 4h12v16H6z" />
        <path d="M9 8h6" />
        <path d="M9 12h6" />
        <path d="M9 16h3" />
      </svg>
    );
  }
  return (
    <svg className="sideIcon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" />
      <path d="m19.4 13.5.1-1.5-.1-1.5 2-1.5-2-3.5-2.5 1a8 8 0 0 0-2.6-1.5L14 2.3h-4l-.4 2.7A8 8 0 0 0 7 6.5l-2.5-1-2 3.5 2 1.5-.1 1.5.1 1.5-2 1.5 2 3.5 2.5-1a8 8 0 0 0 2.6 1.5l.4 2.7h4l.4-2.7A8 8 0 0 0 17 17.5l2.5 1 2-3.5-2.1-1.5Z" />
    </svg>
  );
}

export function AppIcon({ name }: { name: "chevronLeft" | "chevronRight" | "chevronUp" | "chevronDown" | "plus" | "x" | "fileUp" | "arrowUp" | "home" | "refresh" | "download" | "folderPlus" | "edit" | "trash" | "copy" | "rename" | "check" }) {
  return (
    <svg className="buttonIcon" viewBox="0 0 24 24" aria-hidden="true">
      {name === "chevronLeft" && <path d="m15 5-7 7 7 7" />}
      {name === "chevronRight" && <path d="m9 5 7 7-7 7" />}
      {name === "chevronUp" && <path d="m5 15 7-7 7 7" />}
      {name === "chevronDown" && <path d="m5 9 7 7 7-7" />}
      {name === "arrowUp" && (
        <>
          <path d="m12 5-7 7" />
          <path d="m12 5 7 7" />
          <path d="M12 5v14" />
        </>
      )}
      {name === "home" && (
        <>
          <path d="m4 11 8-7 8 7" />
          <path d="M6 10v10h12V10" />
          <path d="M10 20v-6h4v6" />
        </>
      )}
      {name === "refresh" && (
        <>
          <path d="M20 6v5h-5" />
          <path d="M4 18v-5h5" />
          <path d="M18 11a6 6 0 0 0-10-4L4 11" />
          <path d="M6 13a6 6 0 0 0 10 4l4-4" />
        </>
      )}
      {name === "plus" && (
        <>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </>
      )}
      {name === "x" && (
        <>
          <path d="m6 6 12 12" />
          <path d="m18 6-12 12" />
        </>
      )}
      {name === "fileUp" && (
        <>
          <path d="M7 3h7l4 4v14H7z" />
          <path d="M14 3v5h4" />
          <path d="M12 17V10" />
          <path d="m9 13 3-3 3 3" />
        </>
      )}
      {name === "download" && (
        <>
          <path d="M12 4v11" />
          <path d="m8 11 4 4 4-4" />
          <path d="M5 20h14" />
        </>
      )}
      {name === "folderPlus" && (
        <>
          <path d="M3 7h7l2 2h9v10H3z" />
          <path d="M12 14h6" />
          <path d="M15 11v6" />
        </>
      )}
      {name === "edit" && (
        <>
          <path d="M5 19h4l10-10-4-4L5 15z" />
          <path d="m13 7 4 4" />
        </>
      )}
      {name === "trash" && (
        <>
          <path d="M4 7h16" />
          <path d="M9 7V4h6v3" />
          <path d="M7 7l1 13h8l1-13" />
        </>
      )}
      {name === "copy" && (
        <>
          <rect x="8" y="8" width="11" height="11" rx="1.5" />
          <path d="M5 15H4V4h11v1" />
        </>
      )}
      {name === "rename" && (
        <>
          <path d="M4 17h16" />
          <path d="M9 7h6" />
          <path d="M12 7v10" />
        </>
      )}
      {name === "check" && <path d="m5 12 4 4L19 6" />}
    </svg>
  );
}

export function FileTypeIcon({ entry }: { entry: FileEntry }) {
  const kind = fileIconKind(entry);
  return (
    <span className={`fileTypeIcon ${kind}`} aria-hidden="true">
      <svg viewBox="0 0 24 24">
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
