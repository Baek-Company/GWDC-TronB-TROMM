import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTranslator, I18nProvider, LANGUAGE_STORAGE_KEY, LanguageSelector, localizeKnownText, readLanguage, useI18n } from '../src/lib/i18n';

afterEach(() => vi.unstubAllGlobals());

function Example() {
  const { t, locale } = useI18n();
  return <p lang={locale}>{t('조회 시각', 'Fetched at')} · {new Date('2026-09-30T00:00:00Z').toLocaleDateString(locale, { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' })}</p>;
}

describe('language preference and rendering', () => {
  it('defaults to Korean and accepts only the supported saved preference', () => {
    expect(readLanguage()).toBe('ko');
    const getItem = vi.fn().mockReturnValue('en');
    vi.stubGlobal('window', { localStorage: { getItem } });
    expect(readLanguage()).toBe('en');
    expect(getItem).toHaveBeenCalledWith(LANGUAGE_STORAGE_KEY);
    getItem.mockReturnValue('fr');
    expect(readLanguage()).toBe('ko');
  });

  it('continues rendering when browser storage is blocked', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('Storage blocked'); } });
    expect(readLanguage()).toBe('ko');
    expect(renderToStaticMarkup(<I18nProvider><Example /></I18nProvider>)).toContain('조회 시각');
  });

  it('uses English copy and date formatting under the provider', () => {
    const html = renderToStaticMarkup(<I18nProvider initialLanguage="en"><LanguageSelector /><Example /></I18nProvider>);
    expect(html).toContain('Fetched at');
    expect(html).toContain('September 30');
    expect(html).toMatch(/<option[^>]*value="en"[^>]*selected=""/);
    expect(html).not.toContain('조회 시각');
    expect(renderToStaticMarkup(<Example />)).toContain('조회 시각');
  });

  it('keeps interpolated amounts and identifiers intact', () => {
    const amount = '9007199254740993.123456';
    expect(createTranslator('en')(`금액 ${amount} USDT`, `Amount ${amount} USDT`)).toBe(`Amount ${amount} USDT`);
    const messages = [['거래 {0} · 금액 {1}', 'Amount {1} · Transaction {0}']] as const;
    const original = `거래 abc$123 · 금액 ${amount}`;
    const translated = `Amount ${amount} · Transaction abc$123`;
    expect(localizeKnownText(original, createTranslator('en'), messages)).toBe(translated);
    expect(localizeKnownText(translated, createTranslator('ko'), messages)).toBe(original);
    expect(localizeKnownText('Unknown upstream error', createTranslator('en'), messages)).toBe('Unknown upstream error');
  });
});
