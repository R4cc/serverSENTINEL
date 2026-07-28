const menuNavigationKeys = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

export function focusNextMenuItem(event: KeyboardEvent, items: readonly (HTMLButtonElement | null)[]) {
  if (!menuNavigationKeys.has(event.key)) return false;
  event.preventDefault();
  const enabled = items.filter((item): item is HTMLButtonElement => Boolean(item && !item.disabled));
  if (!enabled.length) return true;
  const currentIndex = enabled.indexOf(document.activeElement as HTMLButtonElement);
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? enabled.length - 1
      : event.key === "ArrowDown"
        ? (currentIndex + 1 + enabled.length) % enabled.length
        : (currentIndex - 1 + enabled.length) % enabled.length;
  enabled[nextIndex].focus({ preventScroll: true });
  return true;
}
