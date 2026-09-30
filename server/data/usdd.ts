import Decimal from 'decimal.js';
import { TronWeb } from 'tronweb';
import { psmEntryCapacity, psmExitCapacity, psmRates } from '../../shared/psm-capacity';
import { readMarkets } from '../data';
import { connectionReason, provenance, type DataResult } from './provenance';
import { callConstant, decodeAddress, decodeUint, encodeAddress, readContract } from './tron-rpc';

// Candidate addresses from the USDD MCP's TRON Mainnet chain configuration.
// Every contract and token relationship is checked again against Mainnet RPC.
export const PSM_USDT_ADDRESS = 'TBXW4hS5KYjjbJXDpnrPf4zhkLwrpUjbyz';
export const PSM_USDT_GEM_JOIN = 'TSUYvQ5tdd3DijCD1uGunGLpftHuSZ12sQ';
export const MAINNET_USDT_ADDRESS = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export const MAINNET_USDD_ADDRESS = 'TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz';
export const MAINNET_JUSDD_ADDRESS = 'TKFRELGGoRgiayhwJTNNLqCNjFoLBh3Mnf';
export const USDD_PSM_ADDRESS_SOURCE = 'https://github.com/decentralized-usd/mcp-server-usdd/blob/master/src/core/chains.ts';

export type PsmEvidence = {
  chain: 'mainnet';
  market: 'PSM-USDT';
  psmAddress: string;
  inputToken: { symbol: 'USDT'; address: string; decimals: 6 };
  outputToken: { symbol: 'USDD'; address: string; decimals: 18 };
  jUsddAddress: string;
  jUsddUnderlyingAddress: string | null;
  psmOutputTokenAddress: string | null;
  psmInputTokenAddress: string | null;
  tokenCompatible: boolean | null;
  inputTokenCompatible: boolean | null;
  entryEnabled: boolean;
  exitEnabled: boolean;
  entryFeeRaw: string;
  exitFeeRaw: string;
  entryFeeRate: string;
  exitFeeRate: string;
  entryCapacity: string | null;
  exitCapacity: string | null;
  jUsddListed: boolean | null;
  planReady: false;
  missing: string[];
};

async function readUint(address: string, method: string): Promise<string> {
  return decodeUint(await callConstant('mainnet', address, `${method}()`));
}

let cachedEvidence: { until: number; result: DataResult<PsmEvidence> } | null = null;
let pendingEvidence: Promise<DataResult<PsmEvidence>> | null = null;

export async function readMainnetPsmEvidence(): Promise<DataResult<PsmEvidence>> {
  if (cachedEvidence && Date.now() < cachedEvidence.until) return cachedEvidence.result;
  if (pendingEvidence) return pendingEvidence;
  const pending = probeMainnetPsmEvidence();
  pendingEvidence = pending;
  try {
    const result = await pending;
    // A provider rate limit is a cooldown, not proof that a past result is live.
    // Returning the original result also retains its original provenance timestamp.
    const ttl = result.status === 'ready' ? 15_000 : /HTTP 429$/.test(result.reason) ? 30_000 : 5_000;
    cachedEvidence = { until: Date.now() + ttl, result };
    return result;
  } finally { pendingEvidence = null; }
}

async function probeMainnetPsmEvidence(): Promise<DataResult<PsmEvidence>> {
  const source = provenance('https://api.trongrid.io/wallet/triggerconstantcontract', 'mainnet', 'rpc');
  try {
    const [psm, usdt, usdd, jUsdd, markets] = await Promise.all([
      readContract('mainnet', PSM_USDT_ADDRESS), readContract('mainnet', MAINNET_USDT_ADDRESS),
      readContract('mainnet', MAINNET_USDD_ADDRESS), readContract('mainnet', MAINNET_JUSDD_ADDRESS),
      readMarkets(),
    ]);
    if (![psm, usdt, usdd, jUsdd].every(item => item.hasCode)) {
      return { status: 'unavailable', reason: 'Mainnet PSM, USDT, USDD 또는 jUSDD 계약 코드가 확인되지 않았습니다.', source };
    }
    const jUsddFromRest = markets.markets.find(market => market.symbol === 'jUSDD');
    if (!jUsddFromRest || jUsddFromRest.address !== MAINNET_JUSDD_ADDRESS) {
      return { status: 'unavailable', reason: 'JustLend REST의 현재 jUSDD 주소가 공식 배포 후보와 일치하지 않습니다.', source };
    }
    const [sellRaw, buyRaw, tin, tout, underlyingWord] = await Promise.all([
      readUint(PSM_USDT_ADDRESS, 'sellEnabled'), readUint(PSM_USDT_ADDRESS, 'buyEnabled'),
      readUint(PSM_USDT_ADDRESS, 'tin'), readUint(PSM_USDT_ADDRESS, 'tout'),
      callConstant('mainnet', MAINNET_JUSDD_ADDRESS, 'underlying()'),
    ]);
    const jUsddUnderlyingAddress = decodeAddress(underlyingWord);
    const missing = [] as string[];
    let psmOutputTokenAddress: string | null = null;
    let psmInputTokenAddress: string | null = null;
    let gemJoinCompatible = false;
    try { psmOutputTokenAddress = decodeAddress(await callConstant('mainnet', PSM_USDT_ADDRESS, 'usdd()')); }
    catch { missing.push('PSM 실제 출력 USDD 토큰 주소 미확인'); }
    try {
      const gemJoinAddress = decodeAddress(await callConstant('mainnet', PSM_USDT_ADDRESS, 'gemJoin()'));
      gemJoinCompatible = TronWeb.address.toHex(gemJoinAddress).toLowerCase()
        === TronWeb.address.toHex(PSM_USDT_GEM_JOIN).toLowerCase();
      if (!gemJoinCompatible) {
        missing.push('PSM GemJoin 주소가 배포 후보와 불일치');
      }
      psmInputTokenAddress = decodeAddress(await callConstant('mainnet', gemJoinAddress, 'gem()'));
    } catch { missing.push('PSM 실제 입력 USDT 토큰 주소 미확인'); }
    const tokenCompatible = psmOutputTokenAddress === null ? null
      : TronWeb.address.toHex(jUsddUnderlyingAddress).toLowerCase() === TronWeb.address.toHex(psmOutputTokenAddress).toLowerCase()
        && TronWeb.address.toHex(psmOutputTokenAddress).toLowerCase() === TronWeb.address.toHex(MAINNET_USDD_ADDRESS).toLowerCase();
    const inputTokenCompatible = psmInputTokenAddress === null ? null
      : TronWeb.address.toHex(MAINNET_USDT_ADDRESS).toLowerCase() === TronWeb.address.toHex(psmInputTokenAddress).toLowerCase();
    if (sellRaw !== '1') missing.push('USDT→USDD 전환 비활성');
    if (buyRaw !== '1') missing.push('USDD→USDT 전환 비활성');
    if (tokenCompatible === false) missing.push('PSM 출력 USDD와 jUSDD 기초자산 불일치');
    if (inputTokenCompatible === false) missing.push('PSM 입력 USDT 주소 불일치');
    if (psmOutputTokenAddress && TronWeb.address.toHex(psmOutputTokenAddress).toLowerCase() !== TronWeb.address.toHex(MAINNET_USDD_ADDRESS).toLowerCase()) {
      missing.push('PSM 출력 USDD 주소가 공식 배포 후보와 불일치');
    }
    if (TronWeb.address.toHex(jUsddFromRest.underlyingAddress).toLowerCase()
      !== TronWeb.address.toHex(jUsddUnderlyingAddress).toLowerCase()) missing.push('JustLend REST 기초자산과 온체인 기초자산 불일치');
    let entryCapacity: string | null = null;
    let exitCapacity: string | null = null;
    try {
      if (!gemJoinCompatible) throw new Error('GemJoin candidate mismatch');
      const [vatWord, ilk, gemJoinVatWord, gemJoinIlk, usdtDecimals, usddDecimals] = await Promise.all([
        callConstant('mainnet', PSM_USDT_ADDRESS, 'vat()'),
        callConstant('mainnet', PSM_USDT_ADDRESS, 'ilk()'),
        callConstant('mainnet', PSM_USDT_GEM_JOIN, 'vat()'),
        callConstant('mainnet', PSM_USDT_GEM_JOIN, 'ilk()'),
        readUint(MAINNET_USDT_ADDRESS, 'decimals'), readUint(MAINNET_USDD_ADDRESS, 'decimals'),
      ]);
      const vatAddress = decodeAddress(vatWord);
      if (TronWeb.address.toHex(vatAddress).toLowerCase() !== TronWeb.address.toHex(decodeAddress(gemJoinVatWord)).toLowerCase()
        || !/^[0-9a-fA-F]{64}$/.test(ilk) || ilk.toLowerCase() !== gemJoinIlk.toLowerCase()
        || usdtDecimals !== '6' || usddDecimals !== '18' || !(await readContract('mainnet', vatAddress)).hasCode) {
        missing.push('PSM·GemJoin의 Vat/ilk 연결 또는 토큰 소수점 불일치');
      } else {
        try {
          const [ilkState, globalLine, globalDebt] = await Promise.all([
            callConstant('mainnet', vatAddress, 'ilks(bytes32)', ilk),
            readUint(vatAddress, 'Line'), readUint(vatAddress, 'debt'),
          ]);
          entryCapacity = psmEntryCapacity(ilkState, globalLine, globalDebt);
        } catch { missing.push('Vat 부채 한도에서 PSM 진입 용량 확인 실패'); }
        try {
          exitCapacity = psmExitCapacity(decodeUint(await callConstant('mainnet', MAINNET_USDT_ADDRESS,
            'balanceOf(address)', encodeAddress(PSM_USDT_GEM_JOIN))));
        } catch { missing.push('GemJoin USDT 잔고에서 PSM 출구 유동성 확인 실패'); }
      }
    } catch { missing.push('PSM 양방향 용량의 계약 연결 확인 실패'); }
    if (entryCapacity === null || exitCapacity === null) missing.push('PSM 양방향 수량 한도와 실제 사용 가능 유동성 미확인');
    try { psmRates(tin, tout); }
    catch { missing.push('PSM 수수료 범위 검증 실패'); }
    missing.push('승인·전환·예치·인출 거래의 Energy/Bandwidth 비용 미확인');
    let jUsddListed: boolean | null = null;
    try {
      const comptroller = decodeAddress(await callConstant('mainnet', MAINNET_JUSDD_ADDRESS, 'comptroller()'));
      jUsddListed = decodeUint(await callConstant('mainnet', comptroller, 'markets(address)',
        TronWeb.address.toHex(MAINNET_JUSDD_ADDRESS).slice(2).padStart(64, '0'))) === '1';
      if (!jUsddListed) missing.push('jUSDD 시장 비활성');
    } catch { missing.push('jUSDD 시장 활성 상태 미확인'); }
    return { status: 'ready', value: {
      chain: 'mainnet', market: 'PSM-USDT', psmAddress: PSM_USDT_ADDRESS,
      inputToken: { symbol: 'USDT', address: MAINNET_USDT_ADDRESS, decimals: 6 },
      outputToken: { symbol: 'USDD', address: MAINNET_USDD_ADDRESS, decimals: 18 },
      jUsddAddress: MAINNET_JUSDD_ADDRESS, jUsddUnderlyingAddress, psmOutputTokenAddress, psmInputTokenAddress,
      tokenCompatible, inputTokenCompatible,
      entryEnabled: sellRaw === '1', exitEnabled: buyRaw === '1',
      entryFeeRaw: tin, exitFeeRaw: tout,
      entryFeeRate: new Decimal(tin).div('1e18').toString(),
      exitFeeRate: new Decimal(tout).div('1e18').toString(),
      entryCapacity, exitCapacity, jUsddListed, planReady: false, missing,
    }, source };
  } catch (error) {
    return { status: 'unavailable', reason: connectionReason(error, 'USDD Mainnet PSM'), source };
  }
}
