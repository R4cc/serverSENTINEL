export type FileSelectionModifiers = {
  toggle?: boolean;
  range?: boolean;
  additive?: boolean;
};

export type FileSelectionResult = {
  selectedPaths: string[];
  anchorPath: string;
};

export function fileEntryPointerIntent(eventType: "click" | "double-click") {
  return {
    select: true,
    activate: eventType === "double-click"
  };
}

export function retainedFileFocus(currentPath: string, availablePaths: string[]) {
  return availablePaths.includes(currentPath) ? currentPath : "";
}

export function adjacentFilePath(orderedPaths: string[], currentPath: string, direction: -1 | 1) {
  const currentIndex = orderedPaths.indexOf(currentPath);
  if (currentIndex === -1 || orderedPaths.length === 0) return "";
  return orderedPaths[Math.max(0, Math.min(orderedPaths.length - 1, currentIndex + direction))];
}

export function updateFileSelection(
  currentPaths: string[],
  orderedPaths: string[],
  targetPath: string,
  anchorPath: string,
  modifiers: FileSelectionModifiers = {}
): FileSelectionResult {
  if (modifiers.range) {
    const targetIndex = orderedPaths.indexOf(targetPath);
    const anchorIndex = orderedPaths.indexOf(anchorPath);
    if (targetIndex !== -1 && anchorIndex !== -1) {
      const range = orderedPaths.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1);
      const selectedPaths = modifiers.additive
        ? orderedPaths.filter((path) => currentPaths.includes(path) || range.includes(path))
        : range;
      return { selectedPaths, anchorPath };
    }
  }

  if (modifiers.toggle) {
    const selected = new Set(currentPaths);
    if (selected.has(targetPath)) selected.delete(targetPath);
    else selected.add(targetPath);
    return {
      selectedPaths: orderedPaths.filter((path) => selected.has(path)),
      anchorPath: targetPath
    };
  }

  return { selectedPaths: [targetPath], anchorPath: targetPath };
}
