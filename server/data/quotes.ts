import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { TronWeb } from 'tronweb';
import { psmRates } from '../../shared/psm-capacity';
import { isCurrentInstant } from '../../shared/provenance';
import { productQuoteSchema, type ProductQuote, type Source, type Token } from '../../shared/schemas';
import type { Market, MarketSnapshot } from '../../shared/markets';
import { readMarkets } from '../data';
import { connectionReason, provenance, type Availability, type DataResult } from './provenance';
import { MAINNET_RPC, readNileJtrxProbe, callConstant, decodeAddress, decodeUint, encodeAddress, readContract, readNowBlock } from './tron-rpc';
import { MAINNET_JUSDD_ADDRESS, MAINNET_USDD_ADDRESS, MAINNET_USDT_ADDRESS, readMainnetPsmEvidence, type PsmEvidence } from './usdd';
import { readJustLendMcpMarket } from '../mcp/registry';
import type { McpRead } from '../mcp/clients';
import { MAINNET_JUSDT_ADDRESS, MAINNET_UNITROLLER_ADDRESS, readMainnetJusdtMarket,
  type MainnetJusdtMarketEvidence } from './jusdt-market';

export { MAINNET_JUSDT_ADDRESS, MAINNET_UNITROLLER_ADDRESS } from './jusdt-market';

export type QuoteDiagnostic = { checkId: string; status: Availability; reason: string; source?: Source };
export type MainnetQuotes = { jUsdt: ProductQuote | null; jUsdd: ProductQuote | null; diagnostics: QuoteDiagnostic[];
  psmEvidence: DataResult<PsmEvidence> | null; jUsdtEvidence?: MainnetJusdtMarketEvidence | null };
export type NileQuote = { jTrx: ProductQuote | null; diagnostics: QuoteDiagnostic[];
  ratePerBlockRaw?: string | null; exchangeRateRaw?: string | null };

const trx: Token = { symbol: 'TRX', address: null, decimals: 6 };
const usdt: Token = { symbol: 'USDT', address: MAINNET_USDT_ADDRESS, decimals: 6 };
const usdd: Token = { symbol: 'USDD', address: MAINNET_USDD_ADDRESS, decimals: 18 };
// JustLend's Mainnet deployed-contract directory identifies these entrypoints.
// https://docs.justlend.org/developers/deployed_contracts/

function quoteVersion(fields: unknown): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 20);
}

function restSource(snapshot: MarketSnapshot): Source {
  return { sourceUrl: snapshot.source, chain: 'mainnet', fetchedAt: snapshot.fetchedAt,
    sourceUpdatedAt: snapshot.sourceUpdatedAt, mode: snapshot.mode, accessMethod: 'rest' };
}

function unknownCost(kind: ProductQuote['costs'][number]['kind'], source: Source | null = null): ProductQuote['costs'][number] {
  return { kind, amount: null, asset: trx, conversionRateToInput: null, estimatedAt: null, source };
}

function equalAddress(left: string, right: string): boolean {
  return TronWeb.address.toHex(left).toLowerCase() === TronWeb.address.toHex(right).toLowerCase();
}

const BLOCKS_PER_YEAR = '10512000'; // 3-second block assumption; same basis as the jUSDT on-chain quote.
type MarketVerification = { status: 'ready'; reason: string; ratePerBlockRaw: string; cashRaw: string; source: Source }
  | { status: 'unknown' | 'unavailable'; reason: string };

async function verifyMarket(market: Market | undefined, marketAddress: string,
  underlyingAddress: string, underlyingDecimals: number): Promise<MarketVerification> {
  if (!market || !equalAddress(market.address, marketAddress)
    || !equalAddress(market.underlyingAddress, underlyingAddress)
    || market.underlyingDecimal !== underlyingDecimals) {
    return { status: 'unavailable', reason: 'REST 시장 주소 또는 기초 자산·단위가 공식 배포 정보와 불일치합니다.' };
  }
  try {
    const [marketCode, tokenCode, controllerCode, underlyingWord, decimalsWord, comptrollerWord] = await Promise.all([
      readContract('mainnet', marketAddress), readContract('mainnet', underlyingAddress),
      readContract('mainnet', MAINNET_UNITROLLER_ADDRESS),
      callConstant('mainnet', marketAddress, 'underlying()'),
      callConstant('mainnet', underlyingAddress, 'decimals()'),
      callConstant('mainnet', marketAddress, 'comptroller()'),
    ]);
    if (!marketCode.hasCode || !tokenCode.hasCode || !controllerCode.hasCode) {
      return { status: 'unavailable', reason: '시장·기초 토큰·Unitroller 계약 코드가 확인되지 않았습니다.' };
    }
    if (!equalAddress(decodeAddress(underlyingWord), underlyingAddress)
      || decodeUint(decimalsWord) !== String(underlyingDecimals)
      || !equalAddress(decodeAddress(comptrollerWord), MAINNET_UNITROLLER_ADDRESS)) {
      return { status: 'unavailable', reason: '온체인 기초 자산·단위 또는 Unitroller 주소가 공식 배포 정보와 불일치합니다.' };
    }
    const listed = decodeUint(await callConstant('mainnet', MAINNET_UNITROLLER_ADDRESS,
      'markets(address)', encodeAddress(marketAddress))) === '1';
    if (!listed) return { status: 'unavailable', reason: '공식 Unitroller에서 시장이 활성으로 확인되지 않았습니다.' };
    const [rateWord, cashWord, block] = await Promise.all([
      callConstant('mainnet', marketAddress, 'supplyRatePerBlock()'),
      callConstant('mainnet', marketAddress, 'getCash()'),
      readNowBlock('mainnet'),
    ]);
    if (!isCurrentInstant(block.blockTime, new Date(), 60_000)) {
      return { status: 'unknown', reason: 'jUSDD 온체인 관측 블록의 시각이 신선도 기준을 벗어났습니다.' };
    }
    return { status: 'ready', reason: '공식 시장·기초 자산·Unitroller와 온체인 블록당 공급 금리·현금을 확인했습니다.',
      ratePerBlockRaw: decodeUint(rateWord), cashRaw: decodeUint(cashWord),
      source: { ...provenance(`${MAINNET_RPC}/wallet/triggerconstantcontract`, 'mainnet', 'rpc'),
        sourceUpdatedAt: block.blockTime } };
  } catch (error) {
    return { status: 'unknown', reason: connectionReason(error, 'JustLend Mainnet 계약 검증') };
  }
}

export function diagnoseJustLendMcpRead(market: 'jUSDT' | 'jUSDD', read: DataResult<McpRead>): QuoteDiagnostic[] {
  const checkId = `justlend_mcp_${market.toLowerCase()}`;
  if (read.status !== 'ready') return [{ checkId, status: read.status, reason: read.reason, source: read.source }];
  const envelope = read.value.result;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || !('schemaVersion' in envelope) || typeof envelope.schemaVersion !== 'string'
      || !envelope.schemaVersion.startsWith('1.')
      || !('tool' in envelope) || envelope.tool !== 'get_market_data'
      || !('result' in envelope) || !envelope.result || typeof envelope.result !== 'object') {
    return [{ checkId, status: 'unknown', reason: 'MCP 읽기 응답의 공식 v1 구조를 확인하지 못했습니다. REST 견적에 반영하지 않았습니다.', source: read.source }];
  }
  return [
    { checkId, status: 'ready', reason: `${market} get_market_data 읽기 응답을 받았습니다.`, source: read.source },
    { checkId: `${checkId}_rest_match`, status: 'unknown', reason: 'MCP 시장 주소와 기본 APY의 필드·단위가 검증되지 않아 REST 견적과 대조하지 않았습니다.', source: read.source },
  ];
}

async function readJustLendMcpDiagnostics(): Promise<QuoteDiagnostic[]> {
  const markets = ['jUSDT', 'jUSDD'] as const;
  const reads = await Promise.all(markets.map(market => readJustLendMcpMarket(market, 'mainnet')));
  return reads.flatMap((read, index) => diagnoseJustLendMcpRead(markets[index], read));
}

export async function readMainnetQuotes(options: { selectedRoute?: 'jusdt' } = {}): Promise<MainnetQuotes> {
  if (options.selectedRoute === 'jusdt') {
    // Wallet sizing has one request-wide RPC budget. The unrelated PSM route is
    // inspected by separate market/research reads, not inside this quote path.
    const market = await readMainnetJusdtMarket();
    return { jUsdt: market.quote, jUsdtEvidence: market.evidence, jUsdd: null, psmEvidence: null,
      diagnostics: [...market.diagnostics, { checkId: 'usdd_psm', status: 'unknown',
        reason: 'jUSDT 금액별 평가의 조회 예산을 위해 별도 경로로 남겨 두었습니다.' }] };
  }
  const diagnostics: QuoteDiagnostic[] = [];
  const mcpDiagnostics = readJustLendMcpDiagnostics().catch(error => [{ checkId: 'justlend_mcp',
    status: 'unavailable' as const, reason: connectionReason(error, 'JustLend MCP') }]);
  const jUsdtMarketRead = readMainnetJusdtMarket();
  const psmRead = readMainnetPsmEvidence().catch((error): DataResult<PsmEvidence> => ({
    status: 'unavailable', reason: connectionReason(error, 'USDD PSM'), source: provenance(MAINNET_RPC, 'mainnet', 'rpc'),
  }));
  let snapshot: MarketSnapshot;
  try { snapshot = await readMarkets(); }
  catch (error) {
    diagnostics.push({ checkId: 'justlend_rest', status: 'unavailable', reason: connectionReason(error, 'JustLend Mainnet REST') });
    const [jUsdt, psm] = await Promise.all([jUsdtMarketRead, psmRead]);
    diagnostics.push(...jUsdt.diagnostics);
    if (psm.status !== 'ready') diagnostics.push({ checkId: 'usdd_psm', status: psm.status, reason: psm.reason });
    diagnostics.push(...await mcpDiagnostics);
    return { jUsdt: jUsdt.quote, jUsdtEvidence: jUsdt.evidence, jUsdd: null, diagnostics, psmEvidence: psm };
  }
  const source = restSource(snapshot);
  const jUsddMarket = snapshot.markets.find(item => item.symbol === 'jUSDD');
  const [jUsdtMarket, bVerified, psm] = await Promise.all([
    jUsdtMarketRead,
    verifyMarket(jUsddMarket, MAINNET_JUSDD_ADDRESS, MAINNET_USDD_ADDRESS, 18),
    psmRead,
  ]);
  diagnostics.push(...jUsdtMarket.diagnostics);
  const restJusdt = snapshot.markets.find(item => item.symbol === 'jUSDT');
  if (jUsdtMarket.quote && restJusdt) {
    const matched = equalAddress(restJusdt.address, MAINNET_JUSDT_ADDRESS)
      && equalAddress(restJusdt.underlyingAddress, MAINNET_USDT_ADDRESS)
      && restJusdt.underlyingDecimal === 6;
    diagnostics.push({ checkId: 'justlend_jusdt_rest_crosscheck', status: matched ? 'ready' : 'unknown',
      reason: matched ? 'REST 시장 주소·기초 자산을 온체인 jUSDT와 대조했습니다. REST APY는 별도 참고값입니다.'
        : 'REST jUSDT 주소·기초 자산이 온체인 계약과 일치하지 않습니다. 온체인 견적만 사용합니다.', source });
  }

  let jUsdd: ProductQuote | null = null;
  if (!jUsddMarket || bVerified.status !== 'ready') {
    diagnostics.push({ checkId: 'justlend_jusdd', status: bVerified.status, reason: bVerified.reason });
  } else {
    diagnostics.push({ checkId: 'justlend_jusdd', status: 'ready', reason: bVerified.reason, source: bVerified.source });
    const psmValue: PsmEvidence | null = psm.status === 'ready' ? psm.value : null;
    if (psm.status !== 'ready') diagnostics.push({ checkId: 'usdd_psm', status: psm.status, reason: psm.reason });
    else diagnostics.push({ checkId: 'usdd_psm_capacity',
      status: psm.value.entryCapacity !== null && psm.value.exitCapacity !== null ? 'ready' : 'unknown',
      reason: psm.value.missing.join('; ') });
    let conversionRates: ReturnType<typeof psmRates> | null = null;
    if (psmValue?.entryEnabled && psmValue.exitEnabled && psmValue.inputTokenCompatible
      && psmValue.tokenCompatible && psmValue.entryCapacity !== null && psmValue.exitCapacity !== null) {
      try { conversionRates = psmRates(psmValue.entryFeeRaw, psmValue.exitFeeRaw); }
      catch { /* invalid fee data cannot establish a conversion rate */ }
    }
    jUsdd = productQuoteSchema.parse({
      id: 'mainnet-psm-jusdd', quoteVersion: quoteVersion([jUsddMarket.address, bVerified, psmValue]),
      product: 'psm_jusdd', chain: 'mainnet', marketAddress: jUsddMarket.address,
      inputToken: usdt, depositToken: usdd, receiptToken: { symbol: 'jUSDD', address: jUsddMarket.address, decimals: 8 },
      baseRate: { kind: 'apr', rate: new Decimal(bVerified.ratePerBlockRaw).times(BLOCKS_PER_YEAR).div('1e18').toString() }, reward: null,
      liquidity: { exitAvailable: new Decimal(bVerified.cashRaw).div('1e18').toString(), withdrawalDelayDays: 0 },
      conversion: { entryCapacity: psmValue?.entryCapacity ?? null, exitCapacity: psmValue?.exitCapacity ?? null,
        entryRate: conversionRates?.entryRate ?? null, exitRate: conversionRates?.exitRate ?? null,
        outputTokenAddress: psmValue?.tokenCompatible ? MAINNET_USDD_ADDRESS : null,
        verified: conversionRates !== null },
      costs: ['approval', 'conversion_in', 'deposit', 'withdraw', 'conversion_out', 'network'].map(kind => unknownCost(kind as ProductQuote['costs'][number]['kind'])),
      status: 'active',
      risks: ['USDD 가격 위험', 'PSM 용량은 조회 시점의 상한이며 거래 보장이 아닙니다.',
        '승인·전환·예치·인출 왕복 비용 미확인', ...(psmValue?.missing ?? ['PSM 연결 실패'])],
      source: bVerified.source,
    });
  }
  diagnostics.push(...await mcpDiagnostics);
  return { jUsdt: jUsdtMarket.quote, jUsdtEvidence: jUsdtMarket.evidence, jUsdd, diagnostics, psmEvidence: psm };
}

export async function readNileQuote(walletAddress?: string): Promise<NileQuote> {
  const probe = await readNileJtrxProbe(walletAddress);
  if (probe.status !== 'ready') return { jTrx: null, ratePerBlockRaw: null, exchangeRateRaw: null,
    diagnostics: [{ checkId: 'nile_jtrx', status: probe.status, reason: probe.reason }] };
  const value = probe.value;
  const diagnostics: QuoteDiagnostic[] = value.missing.map((reason, index) => ({ checkId: `nile_jtrx_${index + 1}`, status: 'unknown', reason }));
  diagnostics.push({ checkId: 'nile_jtrx_apy', status: 'unknown', reason: 'Nile 블록당 금리를 연환산할 검증된 블록 시간 기준이 없어 APY를 산정하지 않았습니다.' });
  const jTrx = productQuoteSchema.parse({
    id: 'nile-justlend-jtrx', quoteVersion: quoteVersion(value),
    product: 'justlend_jtrx', chain: 'nile', marketAddress: value.candidateAddress,
    inputToken: trx, depositToken: trx, receiptToken: { symbol: 'jTRX', address: value.candidateAddress, decimals: 8 },
    baseRate: null, reward: null,
    liquidity: { exitAvailable: value.cashSun === null ? null : new Decimal(value.cashSun).div('1e6').toString(), withdrawalDelayDays: 0 },
    conversion: null, costs: [unknownCost('deposit'), unknownCost('withdraw'), unknownCost('network')],
    status: value.marketListed === null ? 'unknown' : value.marketListed ? 'active' : 'inactive',
    risks: ['Nile 시험망 견적입니다. Mainnet 금리와 연결하지 않습니다.', 'Nile 블록당 금리의 연환산 APY 미검증', ...value.missing],
    source: probe.source,
  });
  return { jTrx, diagnostics, ratePerBlockRaw: value.supplyRatePerBlockMantissa,
    exchangeRateRaw: value.exchangeRateMantissa };
}
