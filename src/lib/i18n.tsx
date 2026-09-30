import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type Language = 'ko' | 'en';
export type Translate = (korean: string, english: string) => string;
export const LANGUAGE_STORAGE_KEY = 'tromm-language';

export function readLanguage(): Language {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(LANGUAGE_STORAGE_KEY) === 'en'
      ? 'en' : 'ko';
  } catch {
    return 'ko';
  }
}

export function createTranslator(language: Language): Translate {
  return (korean, english) => language === 'en' ? english : korean;
}

// Translate only explicitly catalogued application messages. Preserve unknown upstream
// diagnostics and interpolate captured amounts/IDs without changing their contents.
export function localizeKnownText(value: string, t: Translate,
  messages: readonly (readonly [string, string])[]): string {
  for (const [ko, en] of messages) {
    if (value === ko || value === en) return t(ko, en);
    for (const source of [ko, en]) {
      if (!/\{\d+\}/.test(source)) continue;
      const captures: string[] = [];
      const parts = source.split(/(\{\d+\})/);
      const pattern = parts.map(part => {
        if (/^\{\d+\}$/.test(part)) {
          const previous = captures.indexOf(part);
          if (previous >= 0) return `\\${previous + 1}`;
          captures.push(part);
          return '([\\s\\S]+?)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('');
      const match = new RegExp(`^${pattern}$`).exec(value);
      if (match) return t(ko, en).replace(/\{\d+\}/g, key => {
        const index = captures.indexOf(key);
        return index >= 0 ? match[index + 1] : key;
      });
    }
  }
  return value;
}

type I18n = {
  language: Language;
  locale: 'ko-KR' | 'en-US';
  t: Translate;
  setLanguage: (language: Language) => void;
};

// Standalone components keep the existing Korean rendering outside the app provider.
const I18nContext = createContext<I18n>({
  language: 'ko', locale: 'ko-KR', t: createTranslator('ko'), setLanguage: () => {},
});

export function I18nProvider({ children, initialLanguage }: {
  children: React.ReactNode;
  initialLanguage?: Language;
}) {
  const [language, updateLanguage] = useState<Language>(() => initialLanguage ?? readLanguage());
  const setLanguage = useCallback((next: Language) => {
    updateLanguage(next);
    try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next); }
    catch { /* Language switching still works when browser storage is unavailable. */ }
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo<I18n>(() => ({
    language, locale: language === 'en' ? 'en-US' : 'ko-KR', t: createTranslator(language), setLanguage,
  }), [language, setLanguage]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() { return useContext(I18nContext); }

export function LanguageSelector() {
  const { language, setLanguage } = useI18n();
  return <select className="language-selector" aria-label="Language / 언어" value={language}
    onChange={event => setLanguage(event.target.value === 'en' ? 'en' : 'ko')}>
    <option value="ko" lang="ko">한국어</option>
    <option value="en" lang="en">English</option>
  </select>;
}
