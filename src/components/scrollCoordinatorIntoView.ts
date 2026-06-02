interface ScrollableElement {
  scrollTop: number;
  readonly scrollHeight: number;
}

export function scrollCoordinatorIntoView(
  enabled: boolean,
  container: ScrollableElement | null | undefined,
): void {
  if (enabled && container) {
    container.scrollTop = container.scrollHeight;
  }
}
