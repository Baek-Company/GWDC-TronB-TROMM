import { afterEach, describe, expect, it, vi } from 'vitest';
import { advanceAgentRequest, analyzeAgentRequest, applyAgentFieldAnswer } from '../server/agent/intake';
import { agentRequestStateSchema, confirmAgentRequest, toUserNeeds, validateAgentRequest } from '../shared/agent-request';

const at = '2026-09-29T14:59:00.000Z'; // 2026-09-29 23:59 in Seoul
const complete = '메인넷에서 1,000 USDT 보유, 오늘부터 30일 운용, 지출 없음, 예비액 0 USDT, 보수형';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('explicit agent request intake', () => {
  it('keeps research-only questions independent of planning requirements', () => {
    const result = advanceAgentRequest({ message: '지금 JustLend 금리와 USDD 출구를 알려주세요?', utteredAt: at });
    expect(result.request.intent).toBe('research_only');
    expect(result.request.explicitFacts.statedHoldings).toBeNull();
    expect(result.validation.status).toBe('research_only');
    expect(result.validation.missingFields).toEqual([]);
    expect(result.nextQuestion).toBeNull();
  });

  it('does not turn a market investment question into a personal plan, including a short keyword query', () => {
    for (const message of ['JustLend 투자 금리는?', '저는 JustLend 투자 금리가 궁금해요', 'JustLend 금리']) {
      const result = advanceAgentRequest({ message, utteredAt: at });
      expect(result.request.intent).toBe('research_only');
      expect(result.request.marketQuestions).toContain(message);
      expect(result.nextQuestion).toBeNull();
    }
    const mixed = advanceAgentRequest({ message: `${complete}, JustLend 금리를 알려주세요?`, utteredAt: at });
    expect(mixed.request.intent).toBe('plan_and_research');
    expect(mixed.request.explicitFacts.statedHoldings).toBe('1000');
  });

  it('retains multiple user-stated expenses with separate KST-anchored dates', () => {
    const result = advanceAgentRequest({
      message: '메인넷에서 1,000 USDT 보유, 오늘부터 30일 운용하고 7일 뒤 200 USDT 지출, 14일 뒤 100 USDT 지출. 예비액 0 USDT, 보수형',
      utteredAt: at, messageId: 'm1',
    });
    expect(result.request.explicitFacts.expenses).toEqual([
      { due: { type: 'relative_days', days: 7 }, amount: '200', asset: 'USDT' },
      { due: { type: 'relative_days', days: 14 }, amount: '100', asset: 'USDT' },
    ]);
    expect(result.request.evidence.find(value => value.path === 'explicitFacts.expenses[0].due')).toMatchObject({
      messageId: 'm1', utteredAt: at,
    });
    expect(result.validation.status).toBe('ready_for_confirmation');
    const needs = toUserNeeds(confirmAgentRequest(result.request));
    expect(needs).toMatchObject({ startDate: '2026-09-29', endDate: '2026-10-29',
      expenses: [{ date: '2026-10-06', amount: '200' }, { date: '2026-10-13', amount: '100' }],
      acceptsUsddRisk: false });
    expect(result.request.explicitFacts.acceptsUsddRisk).toBeNull();
  });

  it('requests a correction when expenses beyond the horizon still exceed current holdings', () => {
    const result = advanceAgentRequest({
      message: '메인넷에서 1000 USDT 보유, 오늘부터 30일 운용, 45일 뒤 1100 USDT 지출, 예비액 0 USDT, 보수형',
      utteredAt: at,
    });
    expect(result.validation.invalidFields).toContain('fundingCoverage');
    expect(result.nextQuestion).toMatchObject({ field: 'fundingCoverage', mode: 'form', ask: false });
    expect(() => confirmAgentRequest(result.request)).toThrow('확인 가능한 계획 입력');
  });

  it('does not require unanswered USDD consent to finish a USDT-only plan', () => {
    const first = advanceAgentRequest({ message: complete, utteredAt: at });
    expect(first.validation.status).toBe('ready_for_confirmation');
    expect(first.validation.candidateInputs.justlend_jusdt.ready).toBe(true);
    expect(first.validation.candidateInputs.psm_jusdd.ready).toBe(false);
    expect(first.validation.candidateInputs.psm_jusdd.missingFields).toContain('acceptsUsddRisk');
    const second = advanceAgentRequest({ message: 'USDD는 허용하지 않아요', current: first.request, utteredAt: at });
    expect(second.request.explicitFacts.acceptsUsddRisk).toBe(false);
    expect(second.validation.candidateInputs.psm_jusdd.excludedReason).toBe('usdd_risk_declined');
  });

  it('keeps USDD consent unknown when the answer is internally contradictory', () => {
    const first = advanceAgentRequest({ message: complete, utteredAt: at });
    const second = advanceAgentRequest({ message: 'USDD는 허용하지만 동의하지 않아요', current: first.request, utteredAt: at });
    expect(second.request.explicitFacts.acceptsUsddRisk).toBeNull();
  });

  it('does not invent a holdings role from an ambiguous amount and stops repeated chat questions', () => {
    const first = advanceAgentRequest({ message: '자산 계획을 세우고 싶어요', utteredAt: at });
    expect(first.nextQuestion?.field).toBe('chain');
    const second = advanceAgentRequest({ message: '100 USDT, 200 USDT', current: first.request, utteredAt: at });
    expect(second.request.explicitFacts.statedHoldings).toBeNull();
    expect(second.nextQuestion).toMatchObject({ field: 'chain', mode: 'form', ask: true });
    const third = advanceAgentRequest({ message: '100 USDT, 200 USDT', current: second.request, utteredAt: at });
    expect(third.nextQuestion).toMatchObject({ field: 'chain', mode: 'form', ask: false });
  });

  it('keeps partial expenses and asks for only their missing part', () => {
    const first = advanceAgentRequest({ message: '메인넷에서 1000 USDT 보유, 오늘부터 30일 운용, 7일 뒤 지출, 예비액 0 USDT, 보수형', utteredAt: at });
    expect(first.request.explicitFacts.expenses[0].due).toEqual({ type: 'relative_days', days: 7 });
    expect(first.validation.missingFields).toContain('expenses[0].amount');
    const second = advanceAgentRequest({ message: '200 USDT', current: first.request, utteredAt: at });
    expect(second.request.explicitFacts.expenses[0]).toMatchObject({ amount: '200', asset: 'USDT' });
    expect(second.validation.status).toBe('ready_for_confirmation');
  });

  it('requires confirmation and never replaces earlier explicit values with an unlabeled amount', () => {
    const first = advanceAgentRequest({ message: complete, utteredAt: at });
    expect(() => toUserNeeds(first.request)).toThrow('확인된 계획 입력');
    const second = advanceAgentRequest({ message: '200 USDT', current: first.request, utteredAt: at });
    expect(second.request.explicitFacts.statedHoldings).toBe('1000');
    expect(second.request.version).toBe(first.request.version);
    expect(toUserNeeds(confirmAgentRequest(first.request)).amount).toBe('1000');
  });

  it('keeps a conflicting change unresolved until it is an explicit correction', () => {
    const first = advanceAgentRequest({ message: complete, utteredAt: at });
    const conflict = advanceAgentRequest({ message: '800 USDT 보유', current: first.request, utteredAt: at });
    expect(conflict.request.explicitFacts.statedHoldings).toBe('1000');
    expect(conflict.validation.conflicts[0]?.path).toBe('explicitFacts.statedHoldings');
    const corrected = advanceAgentRequest({ message: '보유액을 800 USDT로 수정', current: conflict.request, utteredAt: at });
    expect(corrected.request.explicitFacts.statedHoldings).toBe('800');
    expect(corrected.validation.conflicts).toEqual([]);
  });

  it('preserves an 18-decimal USDD statement but rejects excess precision for USDT', () => {
    const usdd = advanceAgentRequest({ message: '메인넷에서 1.123456789012345678 USDD 보유', utteredAt: at });
    expect(usdd.request.explicitFacts.statedHoldings).toBe('1.123456789012345678');
    const usdt = advanceAgentRequest({ message: '메인넷에서 1.1234567 USDT 보유', utteredAt: at });
    expect(validateAgentRequest(usdt.request).invalidFields).toContain('statedHoldings');
  });

  it('ignores NIM clauses that are not verbatim in the user message', async () => {
    vi.stubEnv('NVIDIA_API_KEY', 'test-only');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify({ spans: [{ kind: 'plan_fact', text: '9,999 USDT 보유' }] }) } }],
    }) }));
    const result = await analyzeAgentRequest({ message: complete, utteredAt: at });
    expect(result.extraction.provider).toBe('nim');
    expect(result.request.explicitFacts.statedHoldings).toBe('1000');
  });

  it('uses the deterministic parser when NIM returns malformed JSON', async () => {
    vi.stubEnv('NVIDIA_API_KEY', 'test-only');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      choices: [{ message: { content: '{broken' } }],
    }) }));
    const result = await analyzeAgentRequest({ message: complete, utteredAt: at });
    expect(result.extraction).toMatchObject({ provider: 'template', reason: 'provider_error' });
    expect(result.request.explicitFacts.statedHoldings).toBe('1000');
  });

  it('accepts a verbatim market-question clause from NIM without changing plan facts', async () => {
    vi.stubEnv('NVIDIA_API_KEY', 'test-only');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify({ spans: [
        { kind: 'market_question', text: '지금 JustLend 금리를 알려주세요?' },
      ] }) } }],
    }) }));
    const result = await analyzeAgentRequest({
      message: `${complete}, 지금 JustLend 금리를 알려주세요?`, utteredAt: at,
    });
    expect(result.extraction.provider).toBe('nim');
    expect(result.request.marketQuestions).toContain('지금 JustLend 금리를 알려주세요?');
    expect(result.request.explicitFacts.statedHoldings).toBe('1000');
  });

  it('applies a direct form correction to one field and records only the raw submitted value', () => {
    const first = advanceAgentRequest({ message: complete, utteredAt: at });
    const conflict = advanceAgentRequest({ message: '800 USDT 보유', current: first.request, utteredAt: at });
    const corrected = applyAgentFieldAnswer({ current: conflict.request, field: 'statedHoldings', value: '800',
      messageId: 'form-1', utteredAt: at });
    expect(corrected.fieldError).toBeNull();
    expect(corrected.request.explicitFacts.statedHoldings).toBe('800');
    expect(corrected.request.conflicts).toEqual([]);
    expect(corrected.request.version).toBe(conflict.request.version + 1);
    expect(corrected.request.evidence.find(value => value.path === 'explicitFacts.statedHoldings')).toMatchObject({
      excerpt: '800', messageId: 'form-1',
    });
    expect(corrected.validation.status).toBe('ready_for_confirmation');
  });

  it('turns scheduled selection into an editable draft and accepts a complete expense form value', () => {
    const first = advanceAgentRequest({ message: complete, utteredAt: at });
    const scheduled = applyAgentFieldAnswer({ current: first.request, field: 'expenseDeclaration', value: 'scheduled', utteredAt: at });
    expect(scheduled.request.explicitFacts.expenses).toEqual([{ due: null, amount: null, asset: null }]);
    expect(scheduled.nextQuestion?.field).toBe('expenses[0].due');
    const expense = applyAgentFieldAnswer({ current: scheduled.request, field: 'expenses[0]', value: '7일 뒤 200 USDT',
      utteredAt: at });
    expect(expense.validation.status).toBe('ready_for_confirmation');
    expect(expense.request.evidence.find(value => value.path === 'explicitFacts.expenses[0].due')?.excerpt)
      .toBe('7일 뒤 200 USDT');
    expect(toUserNeeds(confirmAgentRequest(expense.request)).expenses[0].date).toBe('2026-10-06');
  });

  it('rejects an invalid direct form value without changing the request', () => {
    const first = advanceAgentRequest({ message: complete, utteredAt: at });
    const invalid = applyAgentFieldAnswer({ current: first.request, field: 'startDate', value: '2026-02-30', utteredAt: at });
    expect(invalid.fieldError).toContain('시작일');
    expect(invalid.request).toEqual(first.request);
    expect(invalid.nextQuestion).toMatchObject({ field: 'startDate', mode: 'form', ask: false });
  });

  it('preserves false versus unanswered USDD consent in direct form edits', () => {
    const first = advanceAgentRequest({ message: complete, utteredAt: at });
    const declined = applyAgentFieldAnswer({ current: first.request, field: 'acceptsUsddRisk', value: false, utteredAt: at });
    expect(declined.request.explicitFacts.acceptsUsddRisk).toBe(false);
    expect(declined.validation.candidateInputs.psm_jusdd.excludedReason).toBe('usdd_risk_declined');
    const cleared = applyAgentFieldAnswer({ current: declined.request, field: 'acceptsUsddRisk', value: null, utteredAt: at });
    expect(cleared.request.explicitFacts.acceptsUsddRisk).toBeNull();
    expect(cleared.validation.candidateInputs.psm_jusdd.missingFields).toContain('acceptsUsddRisk');
  });

  it('keeps scheduled expenses liquid by default and changes confirmation only on explicit consent', () => {
    const first = advanceAgentRequest({ message: '메인넷에서 1000 USDT 보유, 오늘부터 30일 운용, 7일 뒤 200 USDT 지출, 예비액 0 USDT, 보수형',
      utteredAt: at });
    const confirmed = confirmAgentRequest(first.request);
    expect(toUserNeeds(confirmed).acceptsDatedExpenseLiquidityRisk).toBe(false);
    const asked = advanceAgentRequest({ message: '지출 예정액도 예치해도 되나요?', current: confirmed, utteredAt: at });
    expect(asked.request.explicitFacts.acceptsDatedExpenseLiquidityRisk).toBeNull();
    const accepted = applyAgentFieldAnswer({ current: confirmed, field: 'acceptsDatedExpenseLiquidityRisk',
      value: true, utteredAt: at });
    expect(accepted.request.explicitFacts.acceptsDatedExpenseLiquidityRisk).toBe(true);
    expect(accepted.request.confirmedVersion).toBeNull();
    expect(accepted.request.version).toBe(confirmed.version + 1);
    expect(toUserNeeds(confirmAgentRequest(accepted.request)).acceptsDatedExpenseLiquidityRisk).toBe(true);
    const declined = applyAgentFieldAnswer({ current: accepted.request, field: 'acceptsDatedExpenseLiquidityRisk',
      value: false, utteredAt: at });
    expect(toUserNeeds(confirmAgentRequest(declined.request)).acceptsDatedExpenseLiquidityRisk).toBe(false);
  });

  it('migrates a v1 confirmed request once without inventing expense liquidity consent', () => {
    const first = confirmAgentRequest(advanceAgentRequest({ message: complete, utteredAt: at }).request);
    const old = JSON.parse(JSON.stringify(first));
    old.schemaVersion = 1;
    delete old.explicitFacts.acceptsDatedExpenseLiquidityRisk;
    const migrated = agentRequestStateSchema.parse(old);
    expect(migrated).toMatchObject({ schemaVersion: 2, version: first.version + 1,
      confirmedVersion: null, explicitFacts: { acceptsDatedExpenseLiquidityRisk: null } });
    expect(agentRequestStateSchema.parse(migrated)).toEqual(migrated);
    expect(() => toUserNeeds(migrated)).toThrow('확인된 계획 입력');
  });

  it('reanchors a directly resubmitted relative date and invalidates the old confirmation', () => {
    const first = advanceAgentRequest({ message: complete, utteredAt: at });
    const confirmed = confirmAgentRequest(first.request);
    const edited = applyAgentFieldAnswer({ current: confirmed, field: 'startDate', value: '오늘',
      utteredAt: '2026-09-29T15:01:00.000Z' });
    expect(edited.request.version).toBe(confirmed.version + 1);
    expect(edited.request.confirmedVersion).toBeNull();
    expect(edited.request.evidence.find(value => value.path === 'explicitFacts.startDate')?.utteredAt)
      .toBe('2026-09-29T15:01:00.000Z');
    expect(toUserNeeds(confirmAgentRequest(edited.request)).startDate).toBe('2026-09-30');
  });

  it('reanchors the same relative dates when they are restated in prose on another Seoul day', () => {
    const first = advanceAgentRequest({
      message: '메인넷에서 1000 USDT 보유, 오늘부터 30일 운용, 7일 뒤 200 USDT 지출, 예비액 0 USDT, 보수형',
      utteredAt: at,
    });
    const sameDay = advanceAgentRequest({ message: '오늘부터', current: first.request,
      utteredAt: '2026-09-29T14:59:30.000Z' });
    expect(sameDay.changed).toBe(false);
    const nextDay = advanceAgentRequest({ message: '오늘부터', current: sameDay.request,
      utteredAt: '2026-09-29T15:00:00.000Z' });
    expect(nextDay.changed).toBe(true); // Seoul day just changed at 15:00 UTC.
    expect(toUserNeeds(confirmAgentRequest(nextDay.request)).startDate).toBe('2026-09-30');
    const later = advanceAgentRequest({ message: '7일 뒤 200 USDT 지출', current: nextDay.request,
      utteredAt: '2026-09-29T15:00:00.000Z' });
    expect(later.changed).toBe(true);
    expect(later.request.explicitFacts.expenses).toHaveLength(1);
    expect(toUserNeeds(confirmAgentRequest(later.request)).expenses[0].date).toBe('2026-10-07');
  });

  it('blocks unsupported Mainnet USDD from confirmation without changing the stated facts', () => {
    const result = advanceAgentRequest({
      message: '메인넷에서 1000 USDD 보유, 오늘부터 30일 운용, 지출 없음, 예비액 0 USDD, 보수형', utteredAt: at,
    });
    expect(result.request.explicitFacts).toMatchObject({ chain: 'mainnet', asset: 'USDD' });
    expect(result.validation.status).toBe('incomplete');
    expect(result.validation.invalidFields).toContain('asset');
    expect(result.nextQuestion).toMatchObject({ field: 'asset' });
    expect(result.nextQuestion?.text).toContain('Mainnet USDT 또는 Nile TRX');
    expect(() => confirmAgentRequest(result.request)).toThrow('확인 가능한 계획 입력');
  });

  it('asks to change the chain for Nile USDT and stops repeating when the same chain is returned', () => {
    const first = advanceAgentRequest({
      message: '나일에서 1000 USDT 보유, 오늘부터 30일 운용, 지출 없음, 예비액 0 USDT, 보수형', utteredAt: at,
    });
    expect(first.validation.invalidFields).toContain('chain');
    expect(first.nextQuestion?.field).toBe('chain');
    const second = advanceAgentRequest({ message: '나일', current: first.request, utteredAt: at });
    expect(second.changed).toBe(false);
    expect(second.nextQuestion).toMatchObject({ field: 'chain', mode: 'form' });
    const third = advanceAgentRequest({ message: '나일', current: second.request, utteredAt: at });
    expect(third.nextQuestion).toMatchObject({ field: 'chain', mode: 'form', ask: false });
    const directSame = applyAgentFieldAnswer({ current: third.request, field: 'chain', value: 'nile', utteredAt: at });
    expect(directSame.changed).toBe(false);
    expect(directSame.request.version).toBe(third.request.version);
    expect(directSame.nextQuestion).toMatchObject({ field: 'chain', mode: 'form', ask: false });
    const corrected = applyAgentFieldAnswer({ current: third.request, field: 'chain', value: 'mainnet', utteredAt: at });
    expect(corrected.validation.status).toBe('ready_for_confirmation');
  });

  it('allows a research-only question about an unsupported pair without plan questions', () => {
    const research = advanceAgentRequest({ message: 'Nile USDT 금리는 지금 얼마인가요?', utteredAt: at });
    expect(research.request.intent).toBe('research_only');
    expect(research.validation).toMatchObject({ status: 'research_only', missingFields: [], invalidFields: [] });
    expect(research.nextQuestion).toBeNull();
  });
});
