// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { getLang, setLang } from '../src/i18n';
import { Login } from '../src/screens/Login';

vi.mock('../src/lib/ubus', () => ({
  login: vi.fn(),
  USE_MOCK: false,
  TransportError: class TransportError extends Error {},
}));

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  act(() => render(null, container));
  container.remove();
  setLang('it');
  localStorage.clear();
});

describe('Login language', () => {
  it('shows the current language and switches from the dropdown', async () => {
    await act(() => render(<Login onDone={() => {}} />, container));
    const select = container.querySelector('select')!;
    expect(select.value).toBe('it');
    expect(container.querySelector('button[type="submit"]')!.textContent).toBe('Entra');

    select.value = 'en';
    await act(() => select.dispatchEvent(new Event('change', { bubbles: true })));
    // Il ridisegno lo fa main.tsx: qui si ridisegna a mano come farebbe lui.
    await act(() => render(<Login onDone={() => {}} />, container));

    expect(getLang()).toBe('en');
    expect(localStorage.getItem('travel.lang')).toBe('en');
    expect(container.querySelector('button[type="submit"]')!.textContent).toBe('Sign in');
    expect(container.querySelector('select')!.value).toBe('en');
  });
});
