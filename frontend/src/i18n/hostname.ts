import { defineText } from '.';
import type { HostnameMode } from '../lib/hostname';

/** Il nome inviato nella richiesta DHCP (`lib/hostname.ts`, `HostnamePicker`). */
export const hostnameText = defineText({
  it: {
    mode: {
      none: 'Non inviarlo',
      device: 'Nome del router',
      custom: 'Nome scelto',
    } as Record<HostnameMode, string>,
    notSent: 'non inviato',
    routerName: 'nome del router',
    routerNamed: (name: string) => `nome del router (${name})`,
    field: 'Nome da inviare nella richiesta DHCP',
    placeholder: 'es. laptop',
    invalid: 'Solo lettere, cifre e trattini.',
  },
  en: {
    mode: {
      none: 'Don’t send it',
      device: 'Router name',
      custom: 'Custom name',
    },
    notSent: 'not sent',
    routerName: 'router name',
    routerNamed: (name: string) => `router name (${name})`,
    field: 'Name to send in the DHCP request',
    placeholder: 'e.g. laptop',
    invalid: 'Letters, digits and hyphens only.',
  },
});
