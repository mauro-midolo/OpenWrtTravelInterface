import { useEffect, useState } from 'preact/hooks';
import { getLang, LANGS, onLangChange, setLang, type Lang } from '../i18n';

/** Il menu della lingua, uguale nella pagina di accesso e nelle impostazioni. */
export function LanguageSelect({ id, class: className }: { id?: string; class?: string }) {
  const [lang, setCurrent] = useState<Lang>(getLang());
  useEffect(() => onLangChange(setCurrent), []);

  return (
    <select
      id={id}
      class={className}
      value={lang}
      aria-label="Lingua / Language"
      onChange={(e) => setLang((e.target as HTMLSelectElement).value as Lang)}
    >
      {LANGS.map((entry) => (
        <option key={entry.id} value={entry.id}>
          {entry.label}
        </option>
      ))}
    </select>
  );
}
