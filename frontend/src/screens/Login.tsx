import { useState } from 'preact/hooks';
import { login, TransportError, USE_MOCK } from '../lib/ubus';

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login('root', password);
      onDone();
    } catch (err) {
      setError(
        err instanceof TransportError
          ? err.message
          : 'Password errata. E’ la stessa password di root del router.',
      );
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="screen screen--centered">
      <form class="card login" onSubmit={submit}>
        <h1>Travel Router</h1>
        <p class="muted">Accedi con la password di root del router.</p>

        <label class="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            autocomplete="current-password"
            autofocus
            disabled={busy}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          />
        </label>

        {error && <p class="alert alert--error">{error}</p>}

        <button class="button button--primary" type="submit" disabled={busy || !password}>
          {busy ? 'Accesso in corso…' : 'Entra'}
        </button>

        <a class="button button--ghost" href="/cgi-bin/luci/">
          Apri LuCI
        </a>

        {USE_MOCK && (
          <p class="alert alert--info">
            Simulatore attivo: nessun router collegato, qualsiasi password va bene.
          </p>
        )}
      </form>
    </main>
  );
}
