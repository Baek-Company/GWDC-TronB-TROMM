import { afterEach, describe, expect, it, vi } from 'vitest';
import { TronWeb } from 'tronweb';
import { assessConfirmedNeeds } from '../server/agent/assessment';
import { MAINNET_JUSDT_ADDRESS, MAINNET_UNITROLLER_ADDRESS } from '../server/data/jusdt-market';
import { MAINNET_USDT_ADDRESS } from '../server/data/usdd';
import { userNeedsSchema } from '../shared/schemas';

const WALLET = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const MODEL = 'TTetZxp98wcPaciyBMHYvQkS735RZ3tyXY';
const RATE = 25_000_000_000n;
const word = (value: bigint) => value.toString(16).padStart(64, '0');
const addressWord = (address: string) => TronWeb.address.toHex(address).slice(2).padStart(64, '0');
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const dateShift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00.000Z`)
  + days * 86_400_000).toISOString().slice(0, 10);

function seoulToday(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (name: string) => parts.find(item => item.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

afterEach(() => vi.unstubAllGlobals());

describe('selected Mainnet jUSDT assessment read budget', () => {
  it('completes two wallet-sized legs in at most 40 read-only RPC calls', async () => {
    let block = 100;
    const rpcPaths: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'docs.justlend.org') {
        const address = (base58: string) => ({ address: { base58 } });
        return json({ _meta: { schema_version: '1.2.0' }, networks: { mainnet: {
          comptroller: { unitroller_proxy: address(MAINNET_UNITROLLER_ADDRESS) },
          jtokens: { jUSDT: { symbol: 'jUSDT', status: 'active', underlying_symbol: 'USDT',
            decimals: 8, underlying_decimals: 6, delegator: address(MAINNET_JUSDT_ADDRESS),
            underlying: address(MAINNET_USDT_ADDRESS) } },
          interest_rate_models: { jumpRateUSDT: { ...address(MODEL), role: 'JumpRateModelV2' } },
        } } });
      }
      if (url.hostname === 'open.sun.io') {
        const tokenAddress = url.searchParams.get('tokenAddress')!;
        return json({ code: 0, data: { [tokenAddress]: { quote: { USD: {
          price: tokenAddress === MAINNET_USDT_ADDRESS ? '1' : '0.3', last_updated: Date.now(),
        } } } } });
      }
      expect(url.hostname).toBe('api.trongrid.io');
      expect(init?.method).toBe('POST');
      rpcPaths.push(url.pathname);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.pathname === '/wallet/getnowblock') return json({ block_header: {
        raw_data: { number: block++, timestamp: Date.now() },
      } });
      if (url.pathname === '/wallet/getcontract') return json({ bytecode: '6001', abi: { entrys: [] } });
      if (url.pathname === '/wallet/getchainparameters') return json({ chainParameter: [
        { key: 'getEnergyFee', value: 420 }, { key: 'getTransactionFee', value: 1000 },
        { key: 'getMaxFeeLimit', value: 1_000_000_000 },
      ] });
      if (url.pathname === '/wallet/getaccount') return json({ address: WALLET, balance: 100_000_000,
        owner_permission: { threshold: 1, keys: [{ address: WALLET, weight: 1 }] } });
      if (url.pathname === '/wallet/getaccountresource') return json({ EnergyLimit: 0, EnergyUsed: 0,
        freeNetLimit: 0, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 });
      if (url.pathname === '/wallet/estimateenergy') return json({ result: { result: true }, energy_required: 100 });
      if (url.pathname === '/wallet/triggersmartcontract') return json({ result: { result: true },
        transaction: { raw_data_hex: 'aa'.repeat(100) } });
      if (url.pathname === '/wallet/triggerconstantcontract') {
        const selector = String(body.function_selector);
        const contract = String(body.contract_address);
        const value = selector === 'underlying()' ? addressWord(MAINNET_USDT_ADDRESS)
          : selector === 'comptroller()' ? addressWord(MAINNET_UNITROLLER_ADDRESS)
            : selector === 'interestRateModel()' ? addressWord(MODEL)
              : word(selector === 'decimals()' ? contract === MAINNET_USDT_ADDRESS ? 6n : 8n
                : selector === 'markets(address)' ? 1n
                  : selector === 'mintGuardianPaused(address)' ? 0n
                    : selector === 'supplyRatePerBlock()' || selector.startsWith('getSupplyRate(') ? RATE
                      : selector === 'getCash()' || selector === 'totalBorrows()' ? 1_000_000_000n
                        : selector === 'multiplierPerBlock()' ? 100_000_000_000n
                          : selector === 'jumpMultiplierPerBlock()' ? 200_000_000_000n
                            : selector === 'kink()' ? 800_000_000_000_000_000n
                              : selector === 'balanceOf(address)' ? contract === MAINNET_USDT_ADDRESS
                                ? 1_000_000_000n : 0n
                                : selector === 'allowance(address,address)' ? 0n
                                  : selector === 'approve(address,uint256)' ? 1n : 0n);
        return json({ result: { result: true }, transaction: { ret: [{}] },
          constant_result: [value], energy_used: 100 });
      }
      throw new Error(`Unexpected RPC path ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const today = seoulToday();
    const token = { symbol: 'USDT', address: MAINNET_USDT_ADDRESS, decimals: 6 };
    const needs = userNeedsSchema.parse({ chain: 'mainnet', asset: token, amount: '1000',
      startDate: today, endDate: dateShift(today, 30),
      expenses: [{ date: dateShift(today, 7), amount: '200', asset: token }],
      liquidReserve: '0', riskPreference: 'balanced', acceptsUsddRisk: false,
      acceptsDatedExpenseLiquidityRisk: true, timezone: 'Asia/Seoul',
      inputVersion: 1, confirmedVersion: 1 });
    const assessment = await assessConfirmedNeeds(needs, WALLET);
    expect(assessment.balanceStatus).toBe('ready');
    expect(assessment.observedWalletBalance).toBe('1000');
    expect(assessment.observedFeeBalance?.status).toBe('unknown');
    expect(assessment.observedPosition?.status).toBe('unknown');
    expect(assessment.diagnostics.some(item => item.name === 'jusdt_sizing')).toBe(false);
    expect(assessment.datedAllocation?.legs).toHaveLength(2);
    expect(assessment.datedAllocation?.recommendation).toBe('insufficient_data');
    expect(assessment.jusdtReadOnlyEvidence).toMatchObject({
      chain: 'mainnet', walletAddress: WALLET, needsVersion: 1,
      totalCandidateUsdtRaw: '1000000000', approvalActions: 'approve',
      executionEligible: false,
    });
    expect(assessment.jusdtReadOnlyEvidence?.legs.map(leg => [
      leg.bucketKey, leg.amountUsdtRaw, leg.redeemModelVersion,
    ])).toEqual([
      [`expense:${dateShift(today, 7)}`, '200000000', null],
      [`horizon:${dateShift(today, 30)}`, '800000000', null],
    ]);
    expect(assessment.jusdtReadOnlyEvidence?.legs.every(leg =>
      leg.mintCost.action === 'mint' && leg.mintCost.contextVersion === assessment.jusdtReadOnlyEvidence?.contextVersion,
    )).toBe(true);
    expect(assessment.datedAllocation?.selectedBundleQuote).toBeNull();
    expect(assessment.datedDecision).toMatchObject({ action: 'insufficient_data', executionEligible: false });
    expect(rpcPaths).toHaveLength(39);
    expect(rpcPaths.length).toBeLessThanOrEqual(40);
    expect(rpcPaths.every(path => !/broadcast|sign/i.test(path))).toBe(true);
  }, 30_000);
});
