import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TronWeb } from 'tronweb';
import { checkBuiltPsmTransaction, gemAmountRaw, NilePsmPanel,
  verifyNilePsmUiPreview } from '../src/features/psm/NilePsmPanel';

const wallet = 'TBdTYFvC3CYo2hM1qGgj4aTVU6ifhZWfdu';
const psm = 'TEwUGMSAvbmzjxWoV8JWoSqvQm1A3AXs1V';
const gemJoin = 'TBm4W3JpzsQC4z5mk96fLWZbfNKcfJ5Bxy';
const usdt = 'TZDnq7egPqzi7H4SXy1ABvwaVRvRTaVfJW';
const usdd = 'TYQF9cAeJ3Faq8QXpHxTcFco72DRCQbgFt';

function source() {
  return { sourceUrl: 'https://nile.trongrid.io/wallet/triggerconstantcontract',
    chain: 'nile' as const, fetchedAt: new Date().toISOString(), sourceUpdatedAt: null,
    mode: 'live' as const, accessMethod: 'rpc' as const };
}

function preview(step: 'approve_usdd' | 'buy_gem' | 'approve_usdt' | 'sell_gem' = 'approve_usdd') {
  const buy = step === 'approve_usdd' || step === 'buy_gem';
  const amount = buy ? '1002000000000000000' : '1000000';
  return {
    id: 'psm-preview', step, direction: buy ? 'buy' as const : 'sell' as const,
    walletAddress: wallet,
    contractAddress: step === 'approve_usdd' ? usdd : step === 'approve_usdt' ? usdt : psm,
    method: step.startsWith('approve_') ? 'approve(address,uint256)' as const
      : buy ? 'buyGem(address,uint256)' as const : 'sellGem(address,uint256)' as const,
    argumentAddress: step === 'approve_usdd' ? psm : step === 'approve_usdt' ? gemJoin : wallet,
    amountBaseUnits: step === 'approve_usdd' ? amount : '1000000',
    gemAmountRaw: '1000000', feeLimitSun: '10000000', estimatedFeeSun: '5000000', maxFeeSun: '12000000',
    expiresAt: new Date(Date.now() + 120_000).toISOString(), fingerprint: 'fingerprint', source: source(),
    state: {
      chain: 'nile' as const, walletAddress: wallet, psmAddress: psm, gemJoinAddress: gemJoin,
      usdtAddress: usdt, usddAddress: usdd, usdtBalanceRaw: '1000000', usddBalanceRaw: '2000000000000000000',
      usdtAllowanceToGemJoinRaw: '0', usddAllowanceToPsmRaw: '0', trxBalanceSun: '50000000',
      fetchedAt: new Date().toISOString(), sourceUrl: 'https://nile.trongrid.io', source: source(),
      sellEnabled: true, buyEnabled: true, entryCapacityUsdtRaw: '1000000', exitCapacityUsdtRaw: '1000000',
      quote: { direction: buy ? 'buy_gem' as const : 'sell_gem' as const, gemAmountRaw: '1000000',
        usddAmountRaw: buy ? '1002000000000000000' : '998800000000000000', feeUsddRaw: buy ? '2000000000000000' : '1200000000000000' },
      needsApproval: true, blockedReasons: [],
    },
  };
}

function transaction(value: ReturnType<typeof preview>) {
  const selector = TronWeb.sha3(value.method).replace(/^0x/, '').slice(0, 8);
  const argument = TronWeb.address.toHex(value.argumentAddress).slice(2).padStart(64, '0');
  const amount = BigInt(value.amountBaseUnits).toString(16).padStart(64, '0');
  return {
    txID: 'a'.repeat(64), raw_data_hex: 'ab'.repeat(150),
    raw_data: { fee_limit: Number(value.feeLimitSun), expiration: Date.now() + 60_000,
      contract: [{ type: 'TriggerSmartContract', parameter: { value: {
        owner_address: TronWeb.address.toHex(wallet), contract_address: TronWeb.address.toHex(value.contractAddress),
        data: selector + argument + amount,
      } } }],
    },
  };
}

describe('Nile PSM client confirmation boundary', () => {
  it('turns decimal USDT into exact six-decimal raw units', () => {
    expect(gemAmountRaw('1.000001')).toBe('1000001');
    expect(() => gemAmountRaw('0')).toThrow('0보다 큰');
    expect(() => gemAmountRaw('1.0000001')).toThrow('소수 자릿수');
  });

  it('accepts only the exact Nile PSM token, spender, method, amount and fee budget', () => {
    for (const step of ['approve_usdd', 'buy_gem', 'approve_usdt', 'sell_gem'] as const) {
      expect(verifyNilePsmUiPreview(preview(step), { address: wallet, step, gemAmountRaw: '1000000' }).step).toBe(step);
    }
    expect(() => verifyNilePsmUiPreview({ ...preview(), contractAddress: gemJoin },
      { address: wallet, step: 'approve_usdd', gemAmountRaw: '1000000' })).toThrow();
    expect(() => verifyNilePsmUiPreview({ ...preview(), argumentAddress: wallet },
      { address: wallet, step: 'approve_usdd', gemAmountRaw: '1000000' })).toThrow();
    expect(() => verifyNilePsmUiPreview({ ...preview(), state: { ...preview().state,
      usddAddress: 'TFT7sNiNDGZcqL7z7dwXUPpxrx1Ewk8iGL' } },
      { address: wallet, step: 'approve_usdd', gemAmountRaw: '1000000' })).toThrow();
    expect(() => verifyNilePsmUiPreview({ ...preview(), maxFeeSun: '60000000' },
      { address: wallet, step: 'approve_usdd', gemAmountRaw: '1000000' })).toThrow();
    expect(() => verifyNilePsmUiPreview({ ...preview(), expiresAt: new Date(Date.now() - 1000).toISOString() },
      { address: wallet, step: 'approve_usdd', gemAmountRaw: '1000000' })).toThrow();
  });

  it('rejects a changed unsigned contract call before TronLink sees it', () => {
    const terms = verifyNilePsmUiPreview(preview(),
      { address: wallet, step: 'approve_usdd', gemAmountRaw: '1000000' });
    const built = transaction(preview());
    expect(() => checkBuiltPsmTransaction(built, terms)).not.toThrow();
    expect(() => checkBuiltPsmTransaction({ ...built, raw_data: { ...built.raw_data,
      contract: [{ ...built.raw_data.contract[0], parameter: { value: {
        ...built.raw_data.contract[0].parameter.value, data: 'deadbeef',
      } } }] } }, terms)).toThrow('미리보기');
    expect(() => checkBuiltPsmTransaction({ ...built, raw_data: { ...built.raw_data, fee_limit: 20000000 } },
      terms)).toThrow('미리보기');
  });

  it('labels PSM tokens by contract and never presents a jUSDD route', () => {
    const html = renderToStaticMarkup(createElement(NilePsmPanel, { address: '', networkKey: 'unknown' }));
    expect(html).toContain('PSM 시험 전환');
    expect(html).toContain('기초자산과 달라 예치 경로로 연결하지 않습니다');
    expect(html).not.toContain('jUSDD 예치 버튼');
  });
});
