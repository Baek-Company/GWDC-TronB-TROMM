import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeConversation } from '../server/llm/conversation';
import { emptyAgentRequest } from '../shared/agent-request';
import { AgentPanel, NileAgentFeeEvidence } from '../src/features/agent/AgentPanel';
import { ChatPanel, profileChangeCandidates } from '../src/features/conversation/ChatPanel';
import { createTranslator, I18nProvider } from '../src/lib/i18n';
import { initialProfile } from '../src/lib/session';
import { getWalletState } from '../src/wallet';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('English agent and conversation interface', () => {
  it('renders English controls and safety disclosures while retaining the parsing limitation', () => {
    const html = renderToStaticMarkup(<I18nProvider initialLanguage="en">
      <AgentPanel wallet={getWalletState()} />
      <ChatPanel profile={initialProfile} onFields={() => {}} />
      <NileAgentFeeEvidence scenario={null} />
    </I18nProvider>);
    expect(html).toContain('Plan and research from your stated facts');
    expect(html).toContain('Free-text parsing currently supports Korean primarily');
    expect(html).toContain('read only and do not execute trades');
    expect(html).toContain('AI does not decide yield calculations or whether to trade');
    expect(html).toContain('Reference costs are not confirmed future fees or fee caps');
    expect(html).not.toMatch(/[가-힣]/);
  });

  it('localizes restored field questions without changing the saved facts', () => {
    const request = emptyAgentRequest();
    request.questionState = { ...request.questionState, field: 'risk', id: 'q:0:risk' };
    request.intent = 'plan_only';
    request.explicitFacts.statedHoldings = '1234.56789';
    const original = JSON.stringify(request);
    vi.stubGlobal('localStorage', { getItem: () => original });
    const html = renderToStaticMarkup(<I18nProvider initialLanguage="en"><AgentPanel wallet={getWalletState()} /></I18nProvider>);
    expect(html).toContain('Enter your risk preference: conservative, balanced or growth.');
    expect(html).toContain('placeholder="conservative"');
    expect(html).toContain('1234.56789');
    expect(JSON.stringify(request)).toBe(original);
  });

  it('keeps the English profile review values tied to the same underlying fields', () => {
    const updates = { asset: null, holdings: '1234.56789', horizonDays: null, expense: null,
      expenseDay: null, reserve: null, risk: 'growth' as const, acceptsUsddRisk: null };
    const changes = profileChangeCandidates(initialProfile, updates, createTranslator('en'));
    expect(changes.find(change => change.key === 'holdings')).toEqual({
      key: 'holdings', label: 'Holdings', before: initialProfile.holdings, after: '1234.56789',
    });
    expect(changes.find(change => change.key === 'risk')?.after).toBe('Growth');
  });

  it('returns the selected question language without changing extraction or Korean defaults', async () => {
    vi.stubEnv('NVIDIA_API_KEY', '');
    const korean = await analyzeConversation({ message: '1000 USDT' });
    const english = await analyzeConversation({ message: '1000 USDT', language: 'en' });
    expect(english.fields).toEqual(korean.fields);
    expect(english.updates).toEqual(korean.updates);
    expect(korean.nextQuestion).toBe('자산을 며칠 동안 운용할 계획이신가요?');
    expect(english.nextQuestion).toBe('How many days do you plan to invest?');
  });
});
