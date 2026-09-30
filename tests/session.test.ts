import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmAgentRequest, emptyAgentRequest } from '../shared/agent-request';
import { createMainnetPlans } from '../shared/planning';
import { backupInvalidSession, initialSession, loadSession, parseSession,
  saveSession, LEGACY_SESSION_KEY, PREVIOUS_SESSION_KEY, SESSION_KEY } from '../src/lib/session';

function storage(initial?: string) {
  const entries = new Map<string, string>();
  if (initial !== undefined) entries.set(SESSION_KEY, initial);
  return {
    entries,
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { entries.set(key, value); }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('browser session persistence', () => {
  it('round trips a valid session and distinguishes an absent one', () => {
    const local = storage();
    vi.stubGlobal('localStorage', local);
    expect(loadSession().status).toBe('absent');
    const saved = initialSession();
    saved.profile.holdings = '0.000001';
    saveSession(saved);
    expect(loadSession()).toEqual({ status: 'valid', session: saved });
  });

  it.each(['{"schemaVersion":', JSON.stringify({ ...initialSession(), schemaVersion: 4 })])(
    'keeps unreadable session bytes untouched until an explicit recovery: %s', raw => {
      const local = storage(raw);
      vi.stubGlobal('localStorage', local);
      const loaded = loadSession();
      expect(loaded).toMatchObject({ status: 'invalid', raw });
      expect(local.setItem).not.toHaveBeenCalled();
      expect(local.entries.get(SESSION_KEY)).toBe(raw);
      backupInvalidSession(raw);
      const backup = [...local.entries].find(([key]) => key.startsWith('gwdc-lee-mir-session-backup-'));
      expect(backup?.[1]).toBe(raw);
      expect(local.entries.get(SESSION_KEY)).toBe(raw);
    },
  );

  it('migrates an existing v1 session without deleting its original bytes', () => {
    const oldRecord = {
      id: 'old-record', planId: 'nile:old-v1-plan', previewId: 'old-preview',
      walletAddress: 'TLEGACY', chain: 'nile', txId: null, status: 'preview',
      receipt: null, actualFeeBaseUnits: null, createdAt: '2026-09-29T04:00:00.000Z',
      submittedAt: null, confirmedAt: null, error: null,
    };
    const oldObservation = {
      id: 'old-observation', planId: oldRecord.planId, positionId: 'nile:TLEGACY:TJTRX',
      walletAddress: oldRecord.walletAddress, chain: 'nile',
      receiptToken: { symbol: 'jTRX', address: 'TJTRX', decimals: 8 },
      receiptBalanceBaseUnits: '0', exchangeRateRaw: '1000000000000000000',
      underlyingToken: { symbol: 'TRX', address: null, decimals: 6 }, underlyingValueBaseUnits: '0',
      source: { sourceUrl: 'https://nile.trongrid.io', chain: 'nile',
        fetchedAt: '2026-09-29T04:00:00.000Z', sourceUpdatedAt: null, mode: 'live' },
    };
    const legacy = { ...initialSession(), schemaVersion: 1,
      records: [oldRecord], observations: [oldObservation] };
    delete (legacy as Partial<typeof legacy>).openingObservations;
    delete (legacy as Partial<typeof legacy>).positionFlows;
    delete (legacy as Partial<typeof legacy>).flowCoverages;
    const raw = JSON.stringify(legacy);
    const local = storage();
    local.entries.set(LEGACY_SESSION_KEY, raw);
    vi.stubGlobal('localStorage', local);
    const loaded = loadSession();
    expect(loaded).toMatchObject({ status: 'valid', session: {
      schemaVersion: 3, records: [oldRecord], observations: [oldObservation],
      openingObservations: [], positionFlows: [], flowCoverages: [],
    } });
    expect(local.entries.get(LEGACY_SESSION_KEY)).toBe(raw);
    expect(local.entries.get(SESSION_KEY)).toBeUndefined();
    if (loaded.status === 'valid') saveSession(loaded.session);
    expect(local.entries.get(LEGACY_SESSION_KEY)).toBe(raw);
    expect(local.entries.get(SESSION_KEY)).toBeTruthy();
  });

  it('loads an existing v2 session without treating agent monitoring as a Nile execution selection', () => {
    const previous = initialSession();
    const oldShape = { ...previous } as Partial<typeof previous>;
    oldShape.schemaVersion = 2 as typeof oldShape.schemaVersion;
    delete oldShape.monitoredAgent;
    delete oldShape.monitoredAllocation;
    delete oldShape.latestAgentRequest;
    const parsed = parseSession(JSON.stringify(oldShape));
    expect(parsed.monitoredAgent).toBeNull();
    expect(parsed.monitoredAllocation).toBeNull();
    expect(parsed.latestAgentRequest).toBeNull();
    expect(parsed.selectedPlan).toBeNull();
  });

  it('migrates a v2 saved request once, preserving records while requiring a new confirmation', () => {
    const current = emptyAgentRequest();
    const confirmed = confirmAgentRequest({ ...current, intent: 'plan_only',
      explicitFacts: { ...current.explicitFacts, chain: 'mainnet', asset: 'USDT', statedHoldings: '1000',
        startDate: { type: 'date', date: '2026-09-29' }, horizonDays: 30,
        expenseDeclaration: 'none', reserve: '0', risk: 'balanced' } });
    const needs = {
      chain: 'mainnet' as const, asset: { symbol: 'USDT', address: null, decimals: 6 },
      amount: '1000', startDate: '2026-09-29', endDate: '2026-10-29', expenses: [],
      liquidReserve: '0', riskPreference: 'balanced' as const, acceptsUsddRisk: false,
      timezone: 'Asia/Seoul' as const, inputVersion: confirmed.version, confirmedVersion: confirmed.version,
    };
    const plan = createMainnetPlans(needs, { jUsdt: null, jUsdd: null },
      { now: new Date('2026-09-29T03:00:00.000Z') }).plans.find(item => item.kind === 'hold')!;
    const oldRequest = JSON.parse(JSON.stringify(confirmed));
    oldRequest.schemaVersion = 1;
    delete oldRequest.explicitFacts.acceptsDatedExpenseLiquidityRisk;
    const oldRecord = { id: 'preserved-record', planId: 'nile:old', previewId: 'old-preview',
      walletAddress: 'TLEGACY', chain: 'nile', action: 'deposit', txId: null, status: 'preview',
      receipt: null, actualFeeBaseUnits: null, createdAt: '2026-09-29T03:00:00.000Z',
      submittedAt: null, confirmedAt: null, error: null };
    const old = { ...initialSession(), schemaVersion: 2, records: [oldRecord],
      monitoredAgent: { plan, request: oldRequest, assessmentId: 'old-assessment',
        selectedAt: '2026-09-29T03:00:00.000Z', walletAddress: null },
      latestAgentRequest: oldRequest };
    const raw = JSON.stringify(old);
    const local = storage();
    local.entries.set(PREVIOUS_SESSION_KEY, raw);
    vi.stubGlobal('localStorage', local);
    const loaded = loadSession();
    expect(loaded).toMatchObject({ status: 'valid', session: { schemaVersion: 3, records: [oldRecord],
      monitoredAgent: { plan: { id: plan.id }, needsReconfirmation: true,
        request: { schemaVersion: 2, version: confirmed.version + 1, confirmedVersion: null,
          explicitFacts: { acceptsDatedExpenseLiquidityRisk: null } } },
      latestAgentRequest: { schemaVersion: 2, confirmedVersion: null } } });
    expect(local.entries.get(PREVIOUS_SESSION_KEY)).toBe(raw);
    if (loaded.status === 'valid') saveSession(loaded.session);
    expect(local.entries.get(SESSION_KEY)).toBeTruthy();
  });

  it('rejects an unknown schema version', () => {
    expect(() => parseSession(JSON.stringify({ ...initialSession(), schemaVersion: 4 }))).toThrow();
  });

  it('keeps the in-memory session available if storage refuses a write', () => {
    const local = storage();
    local.setItem.mockImplementation(() => { throw new Error('QuotaExceededError'); });
    vi.stubGlobal('localStorage', local);
    const current = initialSession();
    current.profile.holdings = '123';
    expect(() => saveSession(current)).toThrow('QuotaExceededError');
    expect(current.profile.holdings).toBe('123');
    expect(local.entries.get(SESSION_KEY)).toBeUndefined();
  });
});
