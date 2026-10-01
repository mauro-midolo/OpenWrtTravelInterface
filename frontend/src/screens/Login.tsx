import { useState } from 'preact/hooks';
import { LanguageSelect } from '../components/LanguageSelect';
import { commonText } from '../i18n/common';
import { login, TransportError, USE_MOCK } from '../lib/ubus';

export function Login({ onDone }: { onDone: () => void }) {
  const t = commonText().login;
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // Si ricorda il motivo e non il testo: se si cambia lingua dopo un errore,
  // anche l'errore cambia lingua.
  const [error, setError] = useState<{ transport: string } | 'password' | null>(null);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login('root', password);
      onDone();
    } catch (err) {
      setError(err instanceof TransportError ? { transport: err.message } : 'password');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="screen screen--centered">
      <form class="card login" onSubmit={submit}>
        <div class="login__head">
          <h1>{t.title}</h1>
          <LanguageSelect class="login__lang" />
        </div>
        <p class="muted">{t.subtitle}</p>

        <label class="field">
          <span>{t.password}</span>
          <input
            type="password"
            value={password}
            autocomplete="current-password"
            autofocus
            disabled={busy}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          />
        </label>

        {error && (
          <p class="alert alert--error">
            {error === 'password' ? t.wrongPassword : error.transport}
          </p>
        )}

        <button class="button button--primary" type="submit" disabled={busy || !password}>
          {busy ? t.busy : t.submit}
        </button>

        <a class="button button--ghost" href="/cgi-bin/luci/">
          {t.openLuci}
        </a>

        {USE_MOCK && <p class="alert alert--info">{t.mock}</p>}
      </form>
    </main>
  );
}
