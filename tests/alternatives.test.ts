import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStake2Alternative, readSunStablecoinAlternative } from '../server/data/alternatives';
import { MAINNET_USDD_ADDRESS, MAINNET_USDT_ADDRESS, PSM_USDT_ADDRESS } from '../server/data/usdd';

afterEach(() => vi.unstubAllGlobals());

function reply(body: unknown): Response { return new Response(JSON.stringify(body), { status: 200 }); }

describe('read-only alternative adapters', () => {
  it('reads Stake 2.0 delay and voting state but excludes a USDT yield claim', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/wallet/getchainparameters')) return reply({ chainParameter: [{ key: 'getUnfreezeDelayDays', value: 14 }] });
      if (url.endsWith('/wallet/listwitnesses')) return reply({ witnesses: [{ address: PSM_USDT_ADDRESS }] });
      if (url.endsWith('/wallet/getaccount')) return reply({ address: MAINNET_USDT_ADDRESS, frozenV2: [{ amount: 1000000 }], votes: [{ vote_address: PSM_USDT_ADDRESS, vote_count: 1 }] });
      if (url.endsWith('/wallet/getReward')) return reply({ reward: 1000 });
      throw new Error('unexpected URL');
    }));
    const result = await readStake2Alternative(MAINNET_USDT_ADDRESS);
    expect(result.status).toBe('unknown');
    expect(result.evidence?.unfreezeDelayDays).toBe(14);
    expect(result.evidence?.unclaimedRewardSun).toBe('1000');
    expect(result.quote?.inputToken.symbol).toBe('TRX');
    expect(result.quote?.baseRate).toBeNull();
    expect(result.quote?.liquidity.withdrawalDelayDays).toBe(14);
    expect(result.reasons.some(reason => reason.includes('USDT→TRX'))).toBe(true);
  });

  it('keeps SUN pool metrics separate from an unverified single-asset plan', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ code: 0, data: { list: [{
      poolAddress: PSM_USDT_ADDRESS, protocol: 'CURVE',
      tokenAddressList: [MAINNET_USDT_ADDRESS, MAINNET_USDD_ADDRESS],
      tokenSymbolList: ['USDT', 'USDD'], tokenDecimalList: [6, 18],
      tokenAmountList: ['1000000.123456', '1000000.123456789123456789'],
      feeRate: 0.0004, feeApr: 0.02, farmApr: 0.01, totalApr: 0.03, reserveUsd: 2000000,
    }] } })));
    const result = await readSunStablecoinAlternative();
    expect(result.status).toBe('unknown');
    expect(result.quote).toBeNull();
    expect(result.evidence?.[0].tokenAmounts[1]).toBe('1000000.123456789123456789');
    expect(result.evidence?.[0].singleAssetExitVerified).toBe(false);
    expect(result.source.chain).toBe('mainnet');
  });

  it('rejects SUN business errors without inventing pools', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ code: 429, msg: 'throttled', data: { list: [] } })));
    const result = await readSunStablecoinAlternative();
    expect(result.status).toBe('unavailable');
    expect(result.evidence).toBeNull();
    expect(result.quote).toBeNull();
  });
});
