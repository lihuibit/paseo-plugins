import { useEffect, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  providerOptionsRpc,
  type ProviderOptionsResult,
} from "../shared/contracts";

export interface ProviderOptionsState {
  loading: boolean;
  data: ProviderOptionsResult | null;
  error: string | null;
}

export function useProviderOptions(
  provider: string | null,
  cwd: string | null,
): ProviderOptionsState {
  const fetchOptions = useRpc(providerOptionsRpc);
  const [state, setState] = useState<ProviderOptionsState>({
    loading: false,
    data: null,
    error: null,
  });

  useEffect(() => {
    if (!provider) {
      setState({ loading: false, data: null, error: null });
      return;
    }
    let active = true;
    setState({ loading: true, data: null, error: null });
    void fetchOptions({ provider, cwd: cwd ?? undefined })
      .then((envelope) => {
        if (!active) return;
        if (!envelope.ok) {
          setState({
            loading: false,
            data: null,
            error: `${envelope.error.code}: ${envelope.error.message}`,
          });
          return;
        }
        setState({
          loading: false,
          data: envelope.value,
          error: envelope.value.error,
        });
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setState({
          loading: false,
          data: null,
          error: caught instanceof Error ? caught.message : String(caught),
        });
      });
    return () => {
      active = false;
    };
  }, [cwd, fetchOptions, provider]);

  return state;
}
