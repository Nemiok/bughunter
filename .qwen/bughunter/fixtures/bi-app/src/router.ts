export const NAVIGATE_EVENT = 'bi:navigate';

export function currentPath(): string {
  return window.location.pathname;
}

export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new CustomEvent<string>(NAVIGATE_EVENT, { detail: path }));
}

export function onNavigate(handler: (path: string) => void): () => void {
  const listener = (event: Event): void => {
    handler((event as CustomEvent<string>).detail ?? window.location.pathname);
  };
  const popState = (): void => handler(window.location.pathname);
  window.addEventListener(NAVIGATE_EVENT, listener);
  window.addEventListener('popstate', popState);
  return () => {
    window.removeEventListener(NAVIGATE_EVENT, listener);
    window.removeEventListener('popstate', popState);
  };
}
