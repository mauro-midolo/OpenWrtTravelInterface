import { useCallback, useEffect, useState } from 'preact/hooks';
import { commonText } from './i18n/common';
import { call, clearSession, hasSession } from './lib/ubus';
import { Login } from './screens/Login';
import { Dashboard } from './screens/Dashboard';
import { Wifi } from './screens/Wifi';
import { Lan } from './screens/Lan';
import { Vpn } from './screens/Vpn';
import { Settings } from './screens/Settings';

type Phase = 'checking' | 'login' | 'ready';
type Tab = 'wifi' | 'lan' | 'stato' | 'vpn' | 'impostazioni';

/**
 * Le schede, nell'ordine in cui si usano.
 *
 * Le prime tre sono le reti: quella a cui il router si collega, quella che
 * offre, e come sta messa l'uscita. Poi la VPN, che e' un'operazione da viaggio
 * e non una configurazione da fare una volta - si accende e si spegne a seconda
 * di dove sei, quindi vuole essere a un tocco.
 *
 * Le impostazioni stanno in fondo perche' sono la scheda che si apre di rado:
 * il nome del router, la porta USB e la via per LuCI non c'entrano con gli
 * uplink, e finche' stavano in coda a "Internet" allungavano una schermata
 * che si guarda per tutt'altro motivo.
 */
const TABS: Array<{ id: Tab; label: keyof ReturnType<typeof commonText>['tabs'] }> = [
  { id: 'wifi', label: 'wifi' },
  { id: 'lan', label: 'lan' },
  { id: 'stato', label: 'internet' },
  { id: 'vpn', label: 'vpn' },
  { id: 'impostazioni', label: 'settings' },
];

export function App() {
  const t = commonText();
  const [phase, setPhase] = useState<Phase>('checking');
  // Il WiFi e' la schermata piu' usata: e' quella che si apre per prima.
  const [tab, setTab] = useState<Tab>('wifi');

  // All'avvio non ci si fida del token in sessionStorage: rpcd puo' averlo
  // gia' fatto scadere. Una chiamata vera e' l'unico modo per saperlo.
  useEffect(() => {
    if (!hasSession()) {
      setPhase('login');
      return;
    }
    let cancelled = false;
    void call('travel', 'status')
      .then(() => !cancelled && setPhase('ready'))
      .catch(() => {
        if (cancelled) return;
        clearSession();
        setPhase('login');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setPhase('login');
  }, []);

  if (phase === 'checking') {
    return (
      <main class="screen screen--centered">
        <p class="muted">{t.connecting}</p>
      </main>
    );
  }

  if (phase === 'login') {
    return <Login onDone={() => setPhase('ready')} />;
  }

  return (
    <div class="app">
      {tab === 'wifi' && <Wifi onLogout={logout} />}
      {tab === 'lan' && <Lan onLogout={logout} />}
      {tab === 'stato' && <Dashboard onLogout={logout} />}
      {tab === 'vpn' && <Vpn onLogout={logout} />}
      {tab === 'impostazioni' && <Settings onLogout={logout} />}

      <nav class="tabs">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            class={tab === entry.id ? 'tab tab--on' : 'tab'}
            onClick={() => setTab(entry.id)}
          >
            {t.tabs[entry.label]}
          </button>
        ))}
      </nav>
    </div>
  );
}
