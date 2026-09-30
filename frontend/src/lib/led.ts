import { call } from './ubus';
import { backendError } from './ubus-error';

export interface StatusLedState {
  supported: boolean;
  enabled: boolean;
}

async function request(method: string, args: Record<string, unknown> = {}): Promise<StatusLedState> {
  const result = await call<StatusLedState & { error?: string }>('travel', method, args);
  if (result.error) throw backendError(result);
  return result;
}

export function getStatusLed(): Promise<StatusLedState> {
  return request('led_get');
}

/** Applica subito e salva sul router; riutilizzabile da qualsiasi schermata. */
export function setStatusLed(enabled: boolean): Promise<StatusLedState> {
  return request('led_set', { enabled });
}
