import { useEffect, useState } from 'react';

export type ApiState<T> = { data: T | null; status: number | null };

export function useApi<T>(path: string): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ data: null, status: null });

  useEffect(() => {
    let cancelled = false;
    setState({ data: null, status: null });
    void fetch(path)
      .then(async (response) => {
        const body = response.ok ? await response.json() as T : null;
        if (!cancelled) setState({ data: body, status: response.status });
      })
      .catch(() => {
        if (!cancelled) setState({ data: null, status: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return state;
}
