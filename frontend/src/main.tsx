import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { App } from './app';
import { onLangChange } from './i18n';
import './style.css';

/**
 * Ridisegna tutto al cambio di lingua. `<App />` nasce dentro il render, quindi
 * e' un nodo nuovo ogni volta e l'intero albero si ridisegna con i testi
 * nuovi; lo stato dei componenti resta, perche' la struttura non cambia.
 */
function Root() {
  const [, setRevision] = useState(0);
  useEffect(() => onLangChange(() => setRevision((n) => n + 1)), []);
  return <App />;
}

render(<Root />, document.getElementById('app')!);
