// @vitest-environment jsdom
//
// Le funzioni sono pure, ma vpn.ts importa lib/ubus.ts, che legge
// sessionStorage appena il modulo viene caricato.
import { describe, expect, it } from 'vitest';
import { wgCarrying, wgRoutingSteps } from '../src/lib/vpn';
import type { WgRouting, WgState } from '../src/lib/vpn';

/** Un tunnel acceso, con handshake recente e la catena IPv4 intera. */
function wg(routing: Partial<WgRouting> = {}, fields: Partial<WgState> = {}): WgState {
  return {
    installed: true,
    enabled: true,
    active: 'travel_wg1',
    profiles: [],
    // `now` e' l'ora del ROUTER, non quella del browser: i confronti si fanno
    // con la sua, ed e' lo stesso motivo per cui il campo esiste.
    status: { device_up: true, last_handshake: 1000, rx: 0, tx: 0, peer_endpoint: '', now: 1010 },
    routing: {
      device_up: true,
      rule: true,
      route: true,
      in_zone: true,
      ...routing,
    },
    ...fields,
  } as unknown as WgState;
}

describe('le righe IPv6 sono diagnostica, non un verdetto', () => {
  it('un tunnel v4-only non le mostra affatto', () => {
    const steps = wgRoutingSteps(wg());
    expect(steps).toHaveLength(4);
    expect(steps.some((s) => s.label.includes('IPv6'))).toBe(false);
  });

  it('un profilo con AllowedIPs v6 le mostra', () => {
    const steps = wgRoutingSteps(wg({ has_v6: true, route6: false, rule6: false }));
    expect(steps).toHaveLength(6);
    expect(steps.filter((s) => !s.ok)).toHaveLength(2);
  });

  it('e sono segnate come advisory', () => {
    const steps = wgRoutingSteps(wg({ has_v6: true }));
    const v6 = steps.filter((s) => s.label.includes('IPv6'));

    expect(v6).toHaveLength(2);
    for (const step of v6) expect(step.advisory).toBe(true);
    // Le righe IPv4 no: quelle decidono.
    for (const step of steps.filter((s) => !s.label.includes('IPv6'))) {
      expect(step.advisory).toBeUndefined();
    }
  });
});

describe('wgCarrying', () => {
  it('resta vero con la catena IPv6 incompleta', () => {
    // E' lo stato NORMALE di ogni router finche' `vpn-setup.sh runtime` non e'
    // stato rieseguito dopo l'aggiornamento: il tunnel porta IPv4 benissimo.
    // Contare le righe v6 nel verdetto lo direbbe spento.
    expect(wgCarrying(wg({ has_v6: true, route6: false, rule6: false }))).toBe(true);
  });

  it('resta falso se manca un anello IPv4', () => {
    // Il verdetto non e' stato indebolito: quello che decideva prima decide
    // ancora, ed e' la meta' che conta.
    expect(wgCarrying(wg({ rule: false }))).toBe(false);
    expect(wgCarrying(wg({ route: false }))).toBe(false);
    expect(wgCarrying(wg({ device_up: false }))).toBe(false);
    expect(wgCarrying(wg({ in_zone: false }))).toBe(false);
  });

  it('e’ vero sulla catena intera, con o senza IPv6', () => {
    expect(wgCarrying(wg())).toBe(true);
    expect(wgCarrying(wg({ has_v6: true, route6: true, rule6: true }))).toBe(true);
  });

  it('acceso e handshake restano condizioni prima di tutto', () => {
    expect(wgCarrying(wg({}, { enabled: false }))).toBe(false);
  });
});
