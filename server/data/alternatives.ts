import { createHash } from 'node:crypto';
import { TronWeb } from 'tronweb';
import { productQuoteSchema, type ProductQuote, type Token } from '../../shared/schemas';
import { connectionReason, provenance, type Availability, type DataProvenance } from './provenance';
import { MAINNET_RPC, postTronRpc } from './tron-rpc';
import { MAINNET_USDD_ADDRESS, MAINNET_USDT_ADDRESS } from './usdd';

export const SUN_POOL_API = 'https://open.sun.io/apiv2/pools';
export const STAKE2_DOCS = 'https://developers.tron.network/docs/staking-apis';
export const SUN_POOL_DOCS = 'https://docs.sun.io/api/get-pools/';

export type AlternativeResult<T> = {
  status: Availability;
  quote: ProductQuote | null;
  evidence: T | null;
  reasons: string[];
  source: DataProvenance;
};

export type Stake2Evidence = {
  chain: 'mainnet';
  asset: 'TRX';
  unfreezeDelayDays: number | null;
  witnessCount: number;
  walletAddress: string | null;
  walletFrozenSun: string | null;
  walletVotes: { witnessAddress: string; voteCount: string }[] | null;
  unclaimedRewardSun: string | null;
  rewardApr: null;
  usdtEntryVerified: false;
  usdtExitVerified: false;
};

export type SunPoolEvidence = {
  poolAddress: string;
  protocol: string;
  tokenAddresses: string[];
  tokenSymbols: string[];
  tokenDecimals: number[];
  tokenAmounts: string[];
  feeRate: string | null;
  feeApr: string | null;
  farmApr: string | null;
  totalApr: string | null;
  reserveUsdApprox: string | null;
  singleAssetEntryVerified: false;
  singleAssetExitVerified: false;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid response object');
  return value as Record<string, unknown>;
}

function uint(value: unknown): string {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value).toString();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value).toString();
  throw new Error('Invalid chain integer');
}

function decimalFromApi(value: unknown): string | null {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return String(value);
  return null;
}

function quoteVersion(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
}

function sameAddress(left: string, right: string): boolean {
  return TronWeb.address.toHex(left).toLowerCase() === TronWeb.address.toHex(right).toLowerCase();
}

export async function readStake2Alternative(walletAddress?: string): Promise<AlternativeResult<Stake2Evidence>> {
  const source = provenance(`${MAINNET_RPC}/wallet/getchainparameters`, 'mainnet', 'rpc');
  if (walletAddress && !TronWeb.isAddress(walletAddress)) {
    return { status: 'unavailable', quote: null, evidence: null, reasons: ['공개 지갑 주소 형식이 올바르지 않습니다.'], source };
  }
  try {
    const [parametersRaw, witnessesRaw, accountRaw, rewardRaw] = await Promise.all([
      postTronRpc('mainnet', '/wallet/getchainparameters', {}),
      postTronRpc('mainnet', '/wallet/listwitnesses', {}),
      walletAddress ? postTronRpc('mainnet', '/wallet/getaccount', { address: walletAddress, visible: true }) : Promise.resolve(null),
      walletAddress ? postTronRpc('mainnet', '/wallet/getReward', { address: walletAddress, visible: true }) : Promise.resolve(null),
    ]);
    const params = record(parametersRaw).chainParameter;
    const witnesses = record(witnessesRaw).witnesses;
    if (!Array.isArray(params) || !Array.isArray(witnesses)) throw new Error('Staking RPC schema mismatch');
    const delayEntry = params.map(record).find(item => item.key === 'getUnfreezeDelayDays');
    const delayRaw = delayEntry ? uint(delayEntry.value) : null;
    const unfreezeDelayDays = delayRaw !== null && BigInt(delayRaw) <= 3650n ? Number(delayRaw) : null;
    const account = accountRaw ? record(accountRaw) : null;
    const reward = rewardRaw ? record(rewardRaw) : null;
    const frozen = account && Array.isArray(account.frozenV2)
      ? account.frozenV2.reduce((sum: bigint, item: unknown) => sum + BigInt(uint(record(item).amount ?? 0)), 0n).toString()
      : null;
    const votes = account && Array.isArray(account.votes)
      ? account.votes.flatMap((item: unknown) => {
          const vote = record(item);
          return typeof vote.vote_address === 'string' && TronWeb.isAddress(vote.vote_address)
            ? [{ witnessAddress: vote.vote_address, voteCount: uint(vote.vote_count) }] : [];
        })
      : null;
    const evidence: Stake2Evidence = {
      chain: 'mainnet', asset: 'TRX', unfreezeDelayDays, witnessCount: witnesses.length,
      walletAddress: walletAddress ?? null, walletFrozenSun: frozen, walletVotes: votes,
      unclaimedRewardSun: reward?.reward === undefined ? null : uint(reward.reward),
      rewardApr: null, usdtEntryVerified: false, usdtExitVerified: false,
    };
    const reasons = [
      'Stake 2.0은 TRX를 예치하므로 Mainnet USDT 입력에는 별도 USDT→TRX 전환이 필요합니다.',
      '투표 보상 APR은 SR·투표량·브로커리지에 따라 달라져 현재 조회값만으로 확정할 수 없습니다.',
      'USDT로 돌아오는 출구 견적과 거래 비용이 확인되지 않았습니다.',
      ...(unfreezeDelayDays === null ? ['온체인 해제 대기 기간 미확인'] : [`온체인 해제 대기 기간 ${unfreezeDelayDays}일`]),
    ];
    const trx: Token = { symbol: 'TRX', address: null, decimals: 6 };
    const quote = productQuoteSchema.parse({
      id: 'mainnet-stake2-trx', quoteVersion: quoteVersion([unfreezeDelayDays, witnesses.length]),
      product: 'staking', chain: 'mainnet', marketAddress: null,
      inputToken: trx, depositToken: trx, receiptToken: null,
      baseRate: null, reward: null, liquidity: { exitAvailable: null, withdrawalDelayDays: unfreezeDelayDays },
      conversion: null, costs: ['deposit', 'withdraw', 'claim', 'network'].map(kind => ({
        kind, amount: null, asset: trx, conversionRateToInput: null, estimatedAt: null, source: null,
      })),
      status: 'unknown', risks: reasons, source,
    });
    return { status: 'unknown', quote, evidence, reasons, source };
  } catch (error) {
    return { status: 'unavailable', quote: null, evidence: null, reasons: [connectionReason(error, 'TRON Stake 2.0 RPC')], source };
  }
}

export async function readSunStablecoinAlternative(): Promise<AlternativeResult<SunPoolEvidence[]>> {
  const url = new URL(SUN_POOL_API);
  url.searchParams.set('tokenAddress', MAINNET_USDT_ADDRESS);
  url.searchParams.set('protocol', 'ALL');
  url.searchParams.set('pageNo', '1');
  url.searchParams.set('pageSize', '100');
  url.searchParams.set('sort', 'reserveUsd');
  url.searchParams.set('desc', 'true');
  url.searchParams.set('filterBlackList', 'true');
  const source = provenance(url.toString(), 'mainnet', 'rest');
  try {
    const headers: Record<string, string> = {};
    if (process.env.SUN_API_KEY) headers['X-API-KEY'] = process.env.SUN_API_KEY;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const envelope = record(await response.json());
    if (envelope.code !== 0) throw new Error('SUN API business error');
    const data = record(envelope.data);
    if (!Array.isArray(data.list)) throw new Error('SUN API pool list missing');
    const candidates: SunPoolEvidence[] = [];
    for (const raw of data.list) {
      const pool = record(raw);
      if (typeof pool.poolAddress !== 'string' || !TronWeb.isAddress(pool.poolAddress)
        || !Array.isArray(pool.tokenAddressList) || pool.tokenAddressList.length < 2
        || !pool.tokenAddressList.every((value: unknown) => typeof value === 'string' && TronWeb.isAddress(value))) continue;
      const addresses = pool.tokenAddressList as string[];
      if (!addresses.some(value => sameAddress(value, MAINNET_USDT_ADDRESS))
        || !addresses.some(value => sameAddress(value, MAINNET_USDD_ADDRESS))
        || !addresses.every(value => sameAddress(value, MAINNET_USDT_ADDRESS) || sameAddress(value, MAINNET_USDD_ADDRESS))) continue;
      if (!Array.isArray(pool.tokenSymbolList) || !Array.isArray(pool.tokenDecimalList)
        || !Array.isArray(pool.tokenAmountList) || addresses.length !== pool.tokenSymbolList.length
        || addresses.length !== pool.tokenDecimalList.length || addresses.length !== pool.tokenAmountList.length
        || !pool.tokenSymbolList.every((value: unknown) => typeof value === 'string' && value.length > 0)
        || !pool.tokenDecimalList.every((value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 36)
        || !pool.tokenAmountList.every((value: unknown) => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) continue;
      candidates.push({
        poolAddress: pool.poolAddress, protocol: String(pool.protocol ?? 'unknown'),
        tokenAddresses: addresses, tokenSymbols: pool.tokenSymbolList.map(String),
        tokenDecimals: pool.tokenDecimalList.map(Number), tokenAmounts: pool.tokenAmountList as string[],
        feeRate: decimalFromApi(pool.feeRate), feeApr: decimalFromApi(pool.feeApr),
        farmApr: decimalFromApi(pool.farmApr), totalApr: decimalFromApi(pool.totalApr),
        reserveUsdApprox: decimalFromApi(pool.reserveUsd),
        singleAssetEntryVerified: false, singleAssetExitVerified: false,
      });
    }
    if (candidates.length === 0) return { status: 'unavailable', quote: null, evidence: [],
      reasons: ['SUN.io 조회 결과에서 Mainnet USDT/USDD 주소로 검증된 풀을 찾지 못했습니다.'], source };
    return { status: 'unknown', quote: null, evidence: candidates,
      reasons: ['풀 통계는 조회됐지만 단일 USDT 진입·LP 토큰·회수 경로와 왕복 비용이 확인되지 않았습니다.',
        '풀의 토큰 잔고나 표시 APR만으로 사용자 출금 가능량과 확정 수익을 보장할 수 없습니다.'], source };
  } catch (error) {
    return { status: 'unavailable', quote: null, evidence: null, reasons: [connectionReason(error, 'SUN.io 풀 API')], source };
  }
}
