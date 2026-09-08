/**
 * Client per il canale /ubus di uhttpd (JSON-RPC 2.0).
 *
 * E' l'unico modo in cui l'interfaccia parla con il router: nessuna API REST
 * custom, nessun CGI (decisione D3). L'autenticazione riusa il session manager
 * di rpcd, lo stesso che usa LuCI, quindi non scriviamo codice di login nostro.
 */

import { mockCall } from './mock';
import { UBUS_OK, UBUS_PERMISSION_DENIED, UbusError } from './ubus-error';

/** Sessione "nulla": l'unica cosa che puo' fare e' chiamare session.login. */
const NULL_SESSION = '00000000000000000000000000000000';

const STORAGE_KEY = 'travel.session';

/** Senza VITE_ROUTER in sviluppo si lavora contro il simulatore, senza router. */
export const USE_MOCK = import.meta.env.DEV && !import.meta.env.VITE_ROUTER;

// I codici e il tipo dell'errore vivono a parte, cosi' anche il simulatore
// puo' usarli: qui si ri-esportano perche' resti l'unico punto da importare.
export { UBUS_NOT_FOUND, UBUS_OK, UBUS_PERMISSION_DENIED, UbusError } from './ubus-error';

/** Il router non e' raggiungibile: caso normalissimo su un router da viaggio. */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

let session: string | null = sessionStorage.getItem(STORAGE_KEY);
let nextId = 1;

export function hasSession(): boolean {
  return session !== null;
}

export function clearSession(): void {
  session = null;
  sessionStorage.removeItem(STORAGE_KEY);
}

function setSession(id: string): void {
  session = id;
  sessionStorage.setItem(STORAGE_KEY, id);
}

interface RpcResponse {
  result?: [number, unknown?];
  error?: { code: number; message: string };
}

async function rpc(params: unknown[], timeoutMs: number, where: string): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch('/ubus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'call', params }),
      signal: abort.signal,
    });
  } catch {
    throw new TransportError(
      abort.signal.aborted ? 'Il router non ha risposto in tempo' : 'Router non raggiungibile',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new TransportError(`Il router ha risposto ${response.status}`);
  }

  const body = (await response.json()) as RpcResponse;

  // uhttpd-mod-ubus segnala il rifiuto di una sessione scaduta a livello
  // JSON-RPC, non nel codice di stato ubus: vanno gestiti entrambi.
  if (body.error) {
    const denied = body.error.code === -32002;
    throw new UbusError(
      denied ? UBUS_PERMISSION_DENIED : body.error.code,
      where,
      body.error.message,
    );
  }

  if (!Array.isArray(body.result)) {
    throw new TransportError(`${where}: risposta inattesa dal router`);
  }

  const [status, data] = body.result;
  if (status !== UBUS_OK) {
    throw new UbusError(status, where);
  }
  return data ?? {};
}

/** Invoca un metodo ubus sulla sessione corrente. */
export async function call<T = unknown>(
  object: string,
  method: string,
  args: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<T> {
  if (USE_MOCK) return mockCall<T>(object, method, args);

  const where = `${object}.${method}`;
  if (session === null) {
    throw new UbusError(UBUS_PERMISSION_DENIED, where, 'nessuna sessione attiva');
  }
  return (await rpc([session, object, method, args], timeoutMs, where)) as T;
}

interface LoginResult {
  ubus_rpc_session?: string;
}

/**
 * Login via rpcd. La password non viene mai salvata: dello scambio resta solo
 * il token di sessione, che rpcd fa scadere da solo per inattivita'.
 */
export async function login(username: string, password: string): Promise<void> {
  if (USE_MOCK) {
    setSession('mock-session');
    return;
  }

  const result = (await rpc(
    [NULL_SESSION, 'session', 'login', { username, password }],
    15_000,
    'session.login',
  )) as LoginResult;

  if (!result.ubus_rpc_session) {
    throw new UbusError(UBUS_PERMISSION_DENIED, 'session.login', 'password errata');
  }
  setSession(result.ubus_rpc_session);
}
