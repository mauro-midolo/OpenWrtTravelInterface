/**
 * Profili (requisito H).
 *
 * Un profilo e' un nome dato a **come deve comportarsi il router in un posto**:
 * "hotel", "casa di amici", "coworking". Non e' un backup e non e' una
 * configurazione completa - e' la manciata di scelte che cambiano con il luogo.
 *
 * Cosa contiene: modalita' multi-WAN, ordine e pesi delle WAN, riconnessione
 * automatica, verifica dei portali, kill switch.
 *
 * Cosa **non** contiene, ed e' la parte importante: indirizzo della LAN, pool
 * DHCP, access point, ruolo delle porte ethernet, reti WiFi salvate, chiavi
 * della VPN. Sono le cose da cui si entra nel router, e i segreti. Un profilo
 * che le toccasse potrebbe chiudere fuori chi lo applica con un tocco solo,
 * senza applica-e-conferma - ed e' esattamente la ragione per cui applicarne
 * uno puo' essere un pulsante e basta.
 */

import { call } from './ubus';

export interface ProfileWan {
  network: string;
  enabled: boolean;
  /** Metrica del membro di failover: piu' bassa = preferita. */
  priority: number;
  weight: number;
}

export interface Profile {
  section: string;
  name: string;
  /** Quando e' stato salvato, epoch. */
  saved: number;
  mode: string;
  autoreconnect: boolean;
  portal_check: boolean;
  killswitch: boolean;
  sticky: boolean;
  wans: ProfileWan[];
}

export interface ProfileList {
  /**
   * Il profilo in cui il router si trova adesso, vuoto se nessuno combacia.
   *
   * Lo decide il router confrontando i valori salvati con quelli veri, e non
   * il browser: la stessa regola dei vincoli fra VPN e multi-WAN - una seconda
   * copia del confronto qui prima o poi direbbe una cosa diversa.
   */
  current: string;
  profiles: Profile[];
}

export function listProfiles(): Promise<ProfileList> {
  return call<ProfileList>('travel', 'profile_list');
}

/** Salva lo stato di adesso: nuovo profilo, o sovrascrittura di uno esistente. */
export async function saveProfile(name: string, section = ''): Promise<string> {
  const result = await call<{ section?: string; error?: string }>('travel', 'profile_save', {
    name,
    section,
  });
  if (result.error) throw new Error(result.error);
  return result.section ?? '';
}

/**
 * Applica un profilo.
 *
 * Torna la nota del router quando ha dovuto correggere qualcosa - tipicamente
 * un profilo che chiede il bilanciamento mentre un tunnel VPN e' acceso. Il
 * router non lascia scritto cio' che non applica, e lo dice: e' la stessa
 * regola di `mwan_apply`.
 */
export async function applyProfile(section: string): Promise<string> {
  const result = await call<{ note?: string; error?: string }>('travel', 'profile_apply', {
    section,
  });
  if (result.error) throw new Error(result.error);
  return result.note ?? '';
}

export async function deleteProfile(section: string): Promise<void> {
  const result = await call<{ error?: string }>('travel', 'profile_delete', { section });
  if (result.error) throw new Error(result.error);
}

/** Cosa cambia questo profilo, in una riga. */
export function profileSummary(profile: Profile): string {
  const bits: string[] = [];
  bits.push(profile.mode === 'balance' ? 'bilanciamento' : 'failover');
  if (profile.autoreconnect) bits.push('riconnessione automatica');
  if (profile.killswitch) bits.push('kill switch');
  if (!profile.portal_check) bits.push('senza verifica portali');
  const off = profile.wans.filter((w) => !w.enabled).length;
  if (off > 0) bits.push(`${off} WAN esclus${off === 1 ? 'a' : 'e'}`);
  return bits.join(' · ');
}
