import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeConversation, conversationRequestSchema, templateExtract } from '../server/llm/conversation';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('requirements conversation', () => {
  const completeExceptUsdd = {
    asset: 'USDT' as const, holdings: '1000', horizonDays: 30,
    expense: '200', expenseDay: 7, reserve: '0', risk: 'balanced' as const,
    acceptsUsddRisk: null,
  };

  it.each(['USDD는 허용하지 않아요', 'USDD는 괜찮지 않아요', 'USDD는 동의 못 해요'])(
    'does not turn refusal into consent: %s', async message => {
      vi.stubEnv('NVIDIA_API_KEY', '');
      const result = await analyzeConversation({ message, current: completeExceptUsdd });
      expect(result.fields.acceptsUsddRisk).toBe(false);
      expect(result.complete).toBe(true);
    },
  );

  it('keeps an explicit USDD refusal over a conflicting NIM response', async () => {
    vi.stubEnv('NVIDIA_API_KEY', 'test-only');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify({ ...completeExceptUsdd, acceptsUsddRisk: true }) } }],
    }) }));
    const result = await analyzeConversation({ message: 'USDD는 허용하지 않아요', current: completeExceptUsdd });
    expect(result.fields.acceptsUsddRisk).toBe(false);
    expect(result.updates.acceptsUsddRisk).toBe(false);
  });

  it('asks again on mixed USDD decisions, even when NIM returns consent', async () => {
    vi.stubEnv('NVIDIA_API_KEY', 'test-only');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify({ ...completeExceptUsdd, acceptsUsddRisk: true }) } }],
    }) }));
    const result = await analyzeConversation({ message: 'USDD는 허용하지만 동의하지 않아요', current: completeExceptUsdd });
    expect(result.fields.acceptsUsddRisk).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.nextQuestion).toContain('USDD');
  });

  it('does not treat a question about USDD as risk consent', async () => {
    vi.stubEnv('NVIDIA_API_KEY', '');
    const result = await analyzeConversation({ message: 'USDD를 포함해도 될까요?', current: completeExceptUsdd });
    expect(result.fields.acceptsUsddRisk).toBeNull();
    expect(result.nextQuestion).toContain('USDD');
  });

  it('respects explicit amount roles regardless of their order or repeated values', () => {
    expect(templateExtract('7일 뒤 200 USDT를 지출하고, 1,000 USDT를 보유 중입니다.'))
      .toMatchObject({ holdings: '1000', expense: '200', expenseDay: 7 });
    expect(templateExtract('1,000 USDT 보유, 100 USDT는 예비액'))
      .toMatchObject({ holdings: '1000', reserve: '100', expense: null });
    expect(templateExtract('100 USDT를 지출하고 100 USDT를 보유해요'))
      .toMatchObject({ holdings: '100', expense: '100' });
    expect(templateExtract('100 USDT, 200 USDT'))
      .toMatchObject({ holdings: null, expense: null, reserve: null });
    expect(templateExtract('7일 뒤 200 USDT, 1,000 USDT 보유'))
      .toMatchObject({ holdings: '1000', expense: '200', expenseDay: 7 });
  });

  it('does not let NIM swap explicit expense and holdings roles', async () => {
    vi.stubEnv('NVIDIA_API_KEY', 'test-only');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify({
        asset: 'USDT', holdings: '200', expense: '1000', expenseDay: 7,
        horizonDays: null, reserve: null, risk: null, acceptsUsddRisk: null,
      }) } }],
    }) }));
    const result = await analyzeConversation({ message: '7일 뒤 200 USDT를 지출하고, 1,000 USDT를 보유 중입니다.' });
    expect(result.fields).toMatchObject({ holdings: '1000', expense: '200' });
  });

  it('asks only for the missing part of a partial expense answer', async () => {
    vi.stubEnv('NVIDIA_API_KEY', '');
    const current = { asset: 'USDT' as const, holdings: '1000', horizonDays: 30 };
    const amountFirst = await analyzeConversation({ message: '200 USDT', current });
    expect(amountFirst.nextQuestion).toContain('며칠');
    expect(amountFirst.nextQuestion).not.toContain('얼마');
    const dateSecond = await analyzeConversation({ message: '7일 뒤', current: amountFirst.fields });
    expect(dateSecond.fields).toMatchObject({ expense: '200', expenseDay: 7 });
    const dateFirst = await analyzeConversation({ message: '7일 뒤', current });
    expect(dateFirst.nextQuestion).toContain('얼마');
    const amountSecond = await analyzeConversation({ message: '200 USDT', current: dateFirst.fields });
    expect(amountSecond.fields).toMatchObject({ expense: '200', expenseDay: 7 });
  });

  it('does not reinterpret a short amount during risk or USDD questions as holdings', async () => {
    vi.stubEnv('NVIDIA_API_KEY', '');
    for (const current of [
      { asset: 'USDT' as const, holdings: '1000', horizonDays: 30, expense: '200', expenseDay: 7 },
      completeExceptUsdd,
    ]) {
      const result = await analyzeConversation({ message: '100 USDT', current });
      expect(result.fields.holdings).toBe('1000');
      expect(result.updates.holdings).toBeNull();
    }
  });

  it('allows an explicit correction of the saved holdings', async () => {
    vi.stubEnv('NVIDIA_API_KEY', '');
    const result = await analyzeConversation({
      message: '보유액을 100 USDT로 수정해 주세요', current: completeExceptUsdd,
    });
    expect(result.updates.holdings).toBe('100');
  });
  it('extracts explicit facts without inventing missing risk and reserve values', () => {
    const fields = templateExtract('1,000 USDT를 30일 운용하고 7일 뒤 200 USDT를 지출합니다.');
    expect(fields).toMatchObject({ asset: 'USDT', holdings: '1000', horizonDays: 30,
      expense: '200', expenseDay: 7, risk: null, reserve: null });
  });

  it('keeps confirmed earlier facts while asking for the next missing input when NIM is absent', async () => {
    vi.stubEnv('NVIDIA_API_KEY', '');
    const result = await analyzeConversation({ message: '보수형이고 예비액 0입니다.', current: {
      asset: 'USDT', holdings: '1000', horizonDays: 30, expense: '200', expenseDay: 7,
    } });
    expect(result.provider).toBe('template');
    expect(result.fields).toMatchObject({ holdings: '1000', risk: 'conservative', reserve: '0' });
    expect(result.nextQuestion).toContain('USDD');
  });

  it('rejects unexpected request fields before a provider call', () => {
    expect(conversationRequestSchema.safeParse({ message: '안녕하세요', api_key: 'invalid' }).success).toBe(false);
  });

  it('recognizes a Korean refusal to include USDD in the follow-up question', async () => {
    vi.stubEnv('NVIDIA_API_KEY', '');
    const result = await analyzeConversation({ message: '아니요, USDD는 빼주세요', current: {
      asset: 'USDT', holdings: '1000', horizonDays: 30, expense: '200', expenseDay: 7,
      reserve: '0', risk: 'balanced', acceptsUsddRisk: null,
    } });
    expect(result.fields.acceptsUsddRisk).toBe(false);
    expect(result.complete).toBe(true);
  });

  it('advances through short answers without replacing the confirmed holdings', async () => {
    vi.stubEnv('NVIDIA_API_KEY', '');
    let current = (await analyzeConversation({ message: '1,000 USDT' })).fields;
    expect(current).toMatchObject({ asset: 'USDT', holdings: '1000' });
    for (const [message, next] of [
      ['30일', '언제, 얼마'],
      ['7일 뒤 200 USDT', '위험 성향'],
      ['보수형', '비상 예비액'],
      ['100 USDT', 'USDD 전환'],
    ]) {
      const result = await analyzeConversation({ message, current });
      current = result.fields;
      expect(result.nextQuestion).toContain(next);
      expect(current.holdings).toBe('1000');
    }
    expect(current).toMatchObject({ horizonDays: 30, expenseDay: 7, expense: '200',
      risk: 'conservative', reserve: '100' });
    const finished = await analyzeConversation({ message: '아니요', current });
    expect(finished.fields.acceptsUsddRisk).toBe(false);
    expect(finished.complete).toBe(true);
  });

  it.each(['100', '100 USDT', '0', '없어요'])(
    'treats %s as a reserve answer when reserve is the current question', async message => {
      vi.stubEnv('NVIDIA_API_KEY', '');
      const result = await analyzeConversation({ message, current: {
        asset: 'USDT', holdings: '1000', horizonDays: 30, expense: '200', expenseDay: 7,
        risk: 'balanced', reserve: null,
      } });
      expect(result.fields.holdings).toBe('1000');
      expect(result.fields.reserve).toBe(message === '0' || message === '없어요' ? '0' : '100');
      expect(result.updates.holdings).toBeNull();
      expect(result.nextQuestion).toContain('USDD 전환');
    },
  );

  it.each([
    ['100 USDT를 남겨둘게요', '100'],
    ['한 100 USDT 정도요', '100'],
    ['예비액은 없어요', '0'],
  ])('accepts a natural reserve reply: %s', async (message, expected) => {
    vi.stubEnv('NVIDIA_API_KEY', '');
    const result = await analyzeConversation({ message, current: {
      asset: 'USDT', holdings: '1000', horizonDays: 30, expense: '200', expenseDay: 7,
      risk: 'balanced', reserve: null,
    } });
    expect(result.fields).toMatchObject({ holdings: '1000', reserve: expected });
    expect(result.updates).toMatchObject({ holdings: null, reserve: expected });
    expect(result.nextQuestion).toContain('USDD 전환');
  });

  it('sends only current-turn updates so an earlier chat value cannot overwrite a manual edit', async () => {
    vi.stubEnv('NVIDIA_API_KEY', '');
    const result = await analyzeConversation({ message: '100 USDT', current: {
      asset: 'USDT', holdings: '1000', horizonDays: 30, expense: '200', expenseDay: 7,
      risk: 'balanced', reserve: null,
    } });
    expect(result.fields.holdings).toBe('1000');
    expect(result.updates.holdings).toBeNull();
    expect(result.updates.reserve).toBe('100');
  });

  it('corrects a context-free NIM extraction of a reserve reply', async () => {
    vi.stubEnv('NVIDIA_API_KEY', 'test-only');
    const mockedFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify({
        asset: 'USDT', holdings: '100', horizonDays: null, expense: null,
        expenseDay: null, reserve: null, risk: null, acceptsUsddRisk: null,
      }) } }],
    }) });
    vi.stubGlobal('fetch', mockedFetch);
    const result = await analyzeConversation({ message: '100 USDT를 남겨둘게요', current: {
      asset: 'USDT', holdings: '1000', horizonDays: 30, expense: '200', expenseDay: 7,
      risk: 'balanced', reserve: null,
    } });
    expect(result.provider).toBe('nim');
    expect(result.fields).toMatchObject({ holdings: '1000', reserve: '100' });
    expect(result.updates).toMatchObject({ holdings: null, reserve: '100' });
    expect(JSON.parse(mockedFetch.mock.calls[0][1].body as string)).toMatchObject({ reasoning_effort: 'low' });
  });

  it('retains an explicit USDD refusal when NIM omits it', async () => {
    vi.stubEnv('NVIDIA_API_KEY', 'test-only');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify({
        asset: null, holdings: null, horizonDays: null, expense: null,
        expenseDay: null, reserve: null, risk: null, acceptsUsddRisk: null,
      }) } }],
    }) }));
    const result = await analyzeConversation({ message: 'USDD는 제외합니다', current: {
      asset: 'USDT', holdings: '1000', horizonDays: 30, expense: '200', expenseDay: 7,
      risk: 'balanced', reserve: '0', acceptsUsddRisk: null,
    } });
    expect(result.provider).toBe('nim');
    expect(result.updates.acceptsUsddRisk).toBe(false);
    expect(result.complete).toBe(true);
  });

  it('does not interpret a different asset as the requested reserve', async () => {
    vi.stubEnv('NVIDIA_API_KEY', '');
    const result = await analyzeConversation({ message: '100 TRX', current: {
      asset: 'USDT', holdings: '1000', horizonDays: 30, expense: '200', expenseDay: 7,
      risk: 'balanced', reserve: null,
    } });
    expect(result.fields).toMatchObject({ asset: 'USDT', holdings: '1000', reserve: null });
  });
});
