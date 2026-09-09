import { useState } from 'preact/hooks';
import { StatusLedRow } from './StatusLedRow';
import { PhysicalToggleRow } from './PhysicalToggleRow';
import { controlsLed } from '../lib/toggle';
import type { ToggleAction } from '../lib/toggle';

/**
 * Le due righe che la levetta puo' muovere, con il filo che le tiene d'accordo.
 *
 * Restano due componenti perche' leggono due cose diverse e ognuna sa cavarsela
 * da sola; il filo pero' e' uno, e sta qui invece che dentro una delle due:
 * legarle direttamente vorrebbe dire che la riga del LED sa dell'esistenza
 * della levetta, e allora domani saprebbe anche di tutto il resto.
 *
 * Dalla levetta arrivano due notizie. Che la funzione e' cambiata - e se e' lei
 * a comandare il LED, da quella riga si guarda e basta, altrimenti l'utente
 * potrebbe spegnere dall'interfaccia un LED che la levetta tiene acceso, e a
 * quel punto levetta, LED e schermo direbbero tre cose diverse. E che il router
 * ha appena riallineato il LED alla levetta, che va quindi riletto adesso.
 *
 * Finche' non si sa che funzione ha la levetta il LED resta comandabile: se il
 * router non risponde, bloccare per un dubbio lascerebbe bloccato anche chi non
 * ha nessuna levetta di mezzo.
 */
export function LedAndToggleRows() {
  const [ledRefresh, setLedRefresh] = useState(0);
  const [action, setAction] = useState<ToggleAction | null>(null);

  return (
    <>
      <StatusLedRow refresh={ledRefresh} locked={controlsLed(action)} />
      <PhysicalToggleRow
        onConfig={(config, applied) => {
          setAction(config.action);
          if (applied) setLedRefresh((n) => n + 1);
        }}
      />
    </>
  );
}
