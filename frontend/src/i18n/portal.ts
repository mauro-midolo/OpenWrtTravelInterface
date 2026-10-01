import { defineText } from '.';
import type { PortalState } from '../lib/portal';

/** Il verdetto sull'uscita e i suoi motivi (`lib/portal.ts`). */
export const portalText = defineText({
  it: {
    state: {
      online: 'Internet raggiungibile',
      portal: 'Serve un login',
      blocked: 'Nessuna uscita',
      unknown: 'Non verificata',
    } as Record<PortalState, string>,
    reason: {
      'no-address': 'La WAN non ha un indirizzo: non c’è ancora niente da verificare.',
      dns: (host: string) =>
        `Il nome ${host} non si risolve. È un DNS che non risponde, non un portale: i portali il DNS lo rispondono, è così che portano il browser sulla loro pagina.`,
      'no-policy-routing':
        'Non è stato possibile instradare la verifica su questa WAN. Serve il pacchetto ip-full, che arriva insieme a mwan3.',
      'no-ip': 'Manca il comando ip: senza, la verifica non può uscire dalla WAN giusta.',
      'no-http-client':
        'Sul router non c’è né nc né uclient-fetch: non c’è modo di fare la richiesta, quindi non è la rete a non rispondere — non le è stato chiesto niente.',
      'url-non-http':
        'L’indirizzo di verifica deve essere http:// e non https://: un portale fa fallire una connessione cifrata, e un fallimento non si distingue da una rete che non funziona.',
      occupato: 'Un’altra verifica era in corso. Riprova fra qualche secondo.',
      src_validation:
        'Il firewall ha la validazione della sorgente accesa: le risposte che rientrano da una WAN diversa da quella predefinita vengono scartate, e ogni verifica fuori da quella attiva risulta bloccata senza esserlo.',
    },
    now: 'adesso',
    minutesAgo: (n: number) => `${n} min fa`,
    hoursAgo: (n: number) => `${n} h fa`,
    never: 'mai',
  },
  en: {
    state: {
      online: 'Internet reachable',
      portal: 'Login required',
      blocked: 'No way out',
      unknown: 'Not checked',
    },
    reason: {
      'no-address': 'The WAN has no address: there is nothing to check yet.',
      dns: (host: string) =>
        `The name ${host} does not resolve. That is a DNS not answering, not a portal: portals do answer DNS, that is how they bring the browser to their page.`,
      'no-policy-routing':
        'The check could not be routed over this WAN. It needs the ip-full package, which comes with mwan3.',
      'no-ip': 'The ip command is missing: without it the check cannot leave through the right WAN.',
      'no-http-client':
        'The router has neither nc nor uclient-fetch: there is no way to make the request, so it is not the network failing to answer — nothing was asked.',
      'url-non-http':
        'The check address must be http://, not https://: a portal breaks an encrypted connection, and that failure looks just like a network that does not work.',
      occupato: 'Another check was running. Try again in a few seconds.',
      src_validation:
        'The firewall has source validation on: replies coming back through a WAN other than the default one are dropped, and every check outside the active one looks blocked without being so.',
    },
    now: 'now',
    minutesAgo: (n: number) => `${n} min ago`,
    hoursAgo: (n: number) => `${n} h ago`,
    never: 'never',
  },
});
