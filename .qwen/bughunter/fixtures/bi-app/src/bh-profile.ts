export type WidgetKind = 'table' | 'chart' | 'scene' | 'dom';

export type WidgetDescriptor = { widget: string; kind: WidgetKind; node: string };

export type WidgetBox = { x: number; y: number; width: number; height: number };

export type WidgetPoint = { locator: string; text: string; box: WidgetBox };

export type ResolvedPoint = { locator: string; text: string; role?: string } | null;

export type SceneInfo = { objects: number; layers: string[] } | null;

export type BhProfileHook = {
  version: string;
  widgets(): WidgetDescriptor[];
  extract(widget: string): unknown;
  points(widget: string): WidgetPoint[];
  resolvePoint(point: { x: number; y: number }): ResolvedPoint;
  sceneInfo(): SceneInfo;
};

type Registration = {
  descriptor: WidgetDescriptor;
  extract: () => unknown;
  points?: () => WidgetPoint[];
  resolvePoint?: (point: { x: number; y: number }) => ResolvedPoint;
  sceneInfo?: () => SceneInfo;
};

declare global {
  interface Window {
    __BHProfile: BhProfileHook;
  }
}

const registrations = new Map<string, Registration>();

/**
 * Виджет регистрирует себя на монтировании и снимает регистрацию на размонтировании,
 * поэтому `widgets()` всегда описывает текущий экран, а не всё приложение.
 */
export function registerWidget(registration: Registration): () => void {
  registrations.set(registration.descriptor.widget, registration);
  return () => {
    if (registrations.get(registration.descriptor.widget) === registration) {
      registrations.delete(registration.descriptor.widget);
    }
  };
}

export function installProfileHook(): void {
  window.__BHProfile = {
    version: '1',
    widgets: () => [...registrations.values()].map((registration) => registration.descriptor),
    extract: (widget: string) => {
      const registration = registrations.get(widget);
      if (registration === undefined) throw new Error(`EXTRACTOR_UNKNOWN_WIDGET: ${widget}`);
      return registration.extract();
    },
    points: (widget: string) => registrations.get(widget)?.points?.() ?? [],
    resolvePoint: (point: { x: number; y: number }) => {
      for (const registration of registrations.values()) {
        const resolved = registration.resolvePoint?.(point);
        if (resolved !== undefined && resolved !== null) return resolved;
      }
      return null;
    },
    sceneInfo: () => {
      for (const registration of registrations.values()) {
        const info = registration.sceneInfo?.();
        if (info !== undefined && info !== null) return info;
      }
      return null;
    },
  };
}
