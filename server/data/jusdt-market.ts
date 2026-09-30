import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { TronWeb } from 'tronweb';
import { productQuoteSchema, type JusdtRateModel, type ProductQuote, type Source, type Token } from '../../shared/schemas';
import { supplyRateForDepositRaw, verifiedScenarioApr } from '../../shared/jusdt-rate';
import { connectionReason, provenance } from './provenance';
import { callConstant, decodeAddress, decodeUint, encodeAddress, MAINNET_RPC, readContract, readNowBlock } from './tron-rpc';
import { MAINNET_USDT_ADDRESS } from './usdd';
import type { QuoteDiagnostic } from './quotes';

export const MAINNET_JUSDT_ADDRESS = 'TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd';
export const MAINNET_UNITROLLER_ADDRESS = 'TGjYzgCyPobsNS9n6WcbdLVR9dH7mWqFx7';
const DIRECTORY_URL = 'https://docs.justlend.org/developers/contracts.json';
const BLOCKS_PER_YEAR = '10512000';
const MAX_WINDOW_MS = 30_000;
const MAX_BLOCK_SPAN = 10n;
const MAX_SOURCE_AGE_MS = 60_000;
const usdt: Token = { symbol: 'USDT', address: MAINNET_USDT_ADDRESS, decimals: 6 };
const trx: Token = { symbol: 'TRX', address: null, decimals: 6 };

export type MainnetJusdtMarketEvidence = {
  quoteVersion: string;
  marketAddress: string;
  underlyingAddress: string;
  controllerAddress: string;
  marketCodeIdentity: string;
  underlyingCodeIdentity: string;
  cashRaw: string;
  borrowsRaw: string;
  reservesRaw: string;
  reserveFactorRaw: string;
  supplyRatePerBlockRaw: string;
  interestRateModelAddress: string;
  rateModel: JusdtRateModel | null;
  directorySource: Source;
  source: Source;
  observationWindow: { firstBlock: string; lastBlock: string; startedAt: string; endedAt: string };
  validUntil: string;
};

export type MainnetJusdtMarketRead = {
  quote: ProductQuote | null;
  evidence: MainnetJusdtMarketEvidence | null;
  diagnostics: QuoteDiagnostic[];
};

type Directory = { status: 'active' | 'legacy'; modelRoles: Map<string, 'whitepaper' | 'jump'>; source: Source };
let directoryCache: { value: Directory; until: number } | null = null;
let directoryPending: Promise<Directory> | null = null;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid official directory');
  return value as Record<string, unknown>;
}

function equalAddress(left: string, right: string): boolean {
  return TronWeb.address.toHex(left).toLowerCase() === TronWeb.address.toHex(right).toLowerCase();
}

function addressIn(value: unknown): string {
  const address = object(object(value).address).base58;
  if (typeof address !== 'string' || !TronWeb.isAddress(address)) throw new Error('Invalid official directory address');
  return address;
}

async function fetchDirectory(signal: AbortSignal): Promise<Directory> {
  const response = await fetch(DIRECTORY_URL, { signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = object(await response.json());
  const meta = object(payload._meta);
  if (typeof meta.schema_version !== 'string' || !meta.schema_version.startsWith('1.')) {
    throw new Error('Unsupported official directory schema');
  }
  const mainnet = object(object(payload.networks).mainnet);
  const market = object(object(mainnet.jtokens).jUSDT);
  const status = market.status;
  if (status !== 'active' && status !== 'legacy') throw new Error('Unknown official market status');
  if (market.symbol !== 'jUSDT' || market.underlying_symbol !== 'USDT'
    || market.decimals !== 8 || market.underlying_decimals !== 6
    || !equalAddress(addressIn(market.delegator), MAINNET_JUSDT_ADDRESS)
    || !equalAddress(addressIn(market.underlying), MAINNET_USDT_ADDRESS)
    || !equalAddress(addressIn(object(mainnet.comptroller).unitroller_proxy), MAINNET_UNITROLLER_ADDRESS)) {
    throw new Error('Official jUSDT market identity mismatch');
  }
  const modelRoles = new Map<string, 'whitepaper' | 'jump'>();
  for (const item of Object.values(object(mainnet.interest_rate_models))) {
    const model = object(item);
    if (model.role !== 'WhitePaperInterestRateModel' && model.role !== 'JumpRateModelV2') continue;
    const address = addressIn(model);
    modelRoles.set(TronWeb.address.toHex(address).toLowerCase(), model.role === 'JumpRateModelV2' ? 'jump' : 'whitepaper');
  }
  return { status, modelRoles, source: { ...provenance(DIRECTORY_URL, 'mainnet', 'rest'), sourceUpdatedAt: null } };
}

async function readDirectory(signal: AbortSignal): Promise<Directory> {
  if (directoryCache && directoryCache.until > Date.now()) return directoryCache.value;
  if (!directoryPending) directoryPending = fetchDirectory(signal).then(value => {
    directoryCache = { value, until: Date.now() + 10_000 };
    return value;
  }).finally(() => { directoryPending = null; });
  return directoryPending;
}

function unknownCost(kind: ProductQuote['costs'][number]['kind']): ProductQuote['costs'][number] {
  return { kind, amount: null, asset: trx, conversionRateToInput: null, estimatedAt: null, source: null };
}

function version(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
}

function ageIsCurrent(instant: string, now: number): boolean {
  const age = now - Date.parse(instant);
  return Number.isFinite(age) && age >= -5_000 && age <= MAX_SOURCE_AGE_MS;
}

function encodeUint256(value: string): string {
  if (!/^\d+$/.test(value) || BigInt(value) >= 2n ** 256n) throw new Error('Invalid ABI uint256');
  return BigInt(value).toString(16).padStart(64, '0');
}

async function readRateModel(address: string, kind: 'whitepaper' | 'jump', state: {
  cashRaw: string; borrowsRaw: string; reservesRaw: string; reserveFactorRaw: string; supplyRatePerBlockRaw: string;
}, source: Source, validUntil: string, signal: AbortSignal): Promise<JusdtRateModel | null> {
  const contract = await readContract('mainnet', address, signal);
  if (!contract.hasCode || !contract.codeHash) return null;
  const read = async (selector: string) => decodeUint(await callConstant('mainnet', address, selector, undefined, signal));
  const [baseRatePerBlockRaw, multiplierPerBlockRaw, jumpMultiplierPerBlockRaw, kinkRaw] = await Promise.all([
    read('baseRatePerBlock()'), read('multiplierPerBlock()'),
    kind === 'jump' ? read('jumpMultiplierPerBlock()') : Promise.resolve(null),
    kind === 'jump' ? read('kink()') : Promise.resolve(null),
  ]);
  const model: JusdtRateModel = {
    kind, modelAddress: address, codeIdentity: contract.codeHash,
    baseRatePerBlockRaw, multiplierPerBlockRaw, jumpMultiplierPerBlockRaw, kinkRaw,
    cashRaw: state.cashRaw, borrowsRaw: state.borrowsRaw, reservesRaw: state.reservesRaw,
    reserveFactorRaw: state.reserveFactorRaw, currentSupplyRatePerBlockRaw: state.supplyRatePerBlockRaw,
    source, validUntil,
  };
  const parameter = [state.cashRaw, state.borrowsRaw, state.reservesRaw, state.reserveFactorRaw]
    .map(encodeUint256).join('');
  const onchain = decodeUint(await callConstant('mainnet', address,
    'getSupplyRate(uint256,uint256,uint256,uint256)', parameter, signal));
  if (onchain !== supplyRateForDepositRaw(model, '0') || verifiedScenarioApr(model, '0') === null) return null;
  return model;
}

export async function readMainnetJusdtMarket(): Promise<MainnetJusdtMarketRead> {
  const signal = AbortSignal.timeout(25_000);
  const source = provenance(MAINNET_RPC, 'mainnet', 'rpc');
  try {
    const startedAt = new Date().toISOString();
    const [first, directory] = await Promise.all([readNowBlock('mainnet', signal), readDirectory(signal)]);
    if (directory.status !== 'active') {
      return { quote: null, evidence: null, diagnostics: [{ checkId: 'justlend_jusdt', status: 'unavailable',
        reason: '공식 계약 목록에서 jUSDT 신규 공급 상태가 active가 아닙니다.', source: directory.source }] };
    }
    const [marketContract, tokenContract, controllerContract, underlyingWord, tokenDecimalsWord,
      marketDecimalsWord, comptrollerWord, listedWord, mintPausedWord,
      supplyRateWord, cashWord, borrowsWord, reservesWord, reserveFactorWord, modelWord] = await Promise.all([
      readContract('mainnet', MAINNET_JUSDT_ADDRESS, signal),
      readContract('mainnet', MAINNET_USDT_ADDRESS, signal),
      readContract('mainnet', MAINNET_UNITROLLER_ADDRESS, signal),
      callConstant('mainnet', MAINNET_JUSDT_ADDRESS, 'underlying()', undefined, signal),
      callConstant('mainnet', MAINNET_USDT_ADDRESS, 'decimals()', undefined, signal),
      callConstant('mainnet', MAINNET_JUSDT_ADDRESS, 'decimals()', undefined, signal),
      callConstant('mainnet', MAINNET_JUSDT_ADDRESS, 'comptroller()', undefined, signal),
      callConstant('mainnet', MAINNET_UNITROLLER_ADDRESS, 'markets(address)', encodeAddress(MAINNET_JUSDT_ADDRESS), signal),
      callConstant('mainnet', MAINNET_UNITROLLER_ADDRESS, 'mintGuardianPaused(address)', encodeAddress(MAINNET_JUSDT_ADDRESS), signal),
      callConstant('mainnet', MAINNET_JUSDT_ADDRESS, 'supplyRatePerBlock()', undefined, signal),
      callConstant('mainnet', MAINNET_JUSDT_ADDRESS, 'getCash()', undefined, signal),
      callConstant('mainnet', MAINNET_JUSDT_ADDRESS, 'totalBorrows()', undefined, signal),
      callConstant('mainnet', MAINNET_JUSDT_ADDRESS, 'totalReserves()', undefined, signal),
      callConstant('mainnet', MAINNET_JUSDT_ADDRESS, 'reserveFactorMantissa()', undefined, signal),
      callConstant('mainnet', MAINNET_JUSDT_ADDRESS, 'interestRateModel()', undefined, signal),
    ]);
    if (!marketContract.hasCode || !marketContract.codeHash
      || !tokenContract.hasCode || !tokenContract.codeHash || !controllerContract.hasCode
      || !equalAddress(decodeAddress(underlyingWord), MAINNET_USDT_ADDRESS)
      || decodeUint(tokenDecimalsWord) !== '6' || decodeUint(marketDecimalsWord) !== '8'
      || !equalAddress(decodeAddress(comptrollerWord), MAINNET_UNITROLLER_ADDRESS)
      || decodeUint(listedWord) !== '1' || decodeUint(mintPausedWord) !== '0') {
      return { quote: null, evidence: null, diagnostics: [{ checkId: 'justlend_jusdt', status: 'unavailable',
        reason: 'jUSDT 계약·토큰·Unitroller·신규 공급 상태가 공식 Mainnet 시장과 일치하지 않습니다.', source }] };
    }
    const interestRateModelAddress = decodeAddress(modelWord);
    const cashRaw = decodeUint(cashWord);
    const borrowsRaw = decodeUint(borrowsWord);
    const reservesRaw = decodeUint(reservesWord);
    const reserveFactorRaw = decodeUint(reserveFactorWord);
    const supplyRatePerBlockRaw = decodeUint(supplyRateWord);
    if (BigInt(reserveFactorRaw) > 10n ** 18n) throw new Error('Invalid reserve factor');
    const role = directory.modelRoles.get(TronWeb.address.toHex(interestRateModelAddress).toLowerCase());
    let rateModel: JusdtRateModel | null = null;
    if (role) {
      try {
        rateModel = await readRateModel(interestRateModelAddress, role, {
          cashRaw, borrowsRaw, reservesRaw, reserveFactorRaw, supplyRatePerBlockRaw,
        }, { ...source, fetchedAt: new Date().toISOString() },
        new Date(Date.parse(startedAt) + MAX_SOURCE_AGE_MS).toISOString(), signal);
      } catch { rateModel = null; }
    }
    const last = await readNowBlock('mainnet', signal);
    const endedAt = new Date().toISOString();
    const now = Date.now();
    if (Date.parse(endedAt) - Date.parse(startedAt) > MAX_WINDOW_MS
      || BigInt(last.blockNumber) < BigInt(first.blockNumber)
      || BigInt(last.blockNumber) - BigInt(first.blockNumber) > MAX_BLOCK_SPAN
      || !ageIsCurrent(first.blockTime, now) || !ageIsCurrent(last.blockTime, now)
      || !ageIsCurrent(directory.source.fetchedAt, now)) {
      return { quote: null, evidence: null, diagnostics: [{ checkId: 'justlend_jusdt', status: 'unknown',
        reason: 'jUSDT 관측 블록 또는 공식 시장 상태의 시각이 신선도 기준을 벗어났습니다.', source }] };
    }
    const validUntil = new Date(Math.min(Date.parse(startedAt) + MAX_SOURCE_AGE_MS,
      Date.parse(directory.source.fetchedAt) + MAX_SOURCE_AGE_MS, Date.parse(endedAt) + 120_000)).toISOString();
    const liveSource: Source = { ...source, fetchedAt: endedAt };
    if (rateModel) rateModel = { ...rateModel, source: liveSource, validUntil };
    const observationWindow = { firstBlock: first.blockNumber, lastBlock: last.blockNumber, startedAt, endedAt };
    const evidenceBase: Omit<MainnetJusdtMarketEvidence, 'quoteVersion'> = {
      marketAddress: MAINNET_JUSDT_ADDRESS, underlyingAddress: MAINNET_USDT_ADDRESS,
      controllerAddress: MAINNET_UNITROLLER_ADDRESS,
      marketCodeIdentity: marketContract.codeHash,
      underlyingCodeIdentity: tokenContract.codeHash,
      cashRaw, borrowsRaw, reservesRaw,
      reserveFactorRaw, supplyRatePerBlockRaw, interestRateModelAddress, rateModel,
      directorySource: directory.source, source: liveSource, observationWindow, validUntil,
    };
    const evidence: MainnetJusdtMarketEvidence = { ...evidenceBase,
      quoteVersion: version(evidenceBase) };
    const quote = productQuoteSchema.parse({
      id: 'mainnet-justlend-jusdt', quoteVersion: evidence.quoteVersion,
      product: 'justlend_jusdt', chain: 'mainnet', marketAddress: MAINNET_JUSDT_ADDRESS,
      inputToken: usdt, depositToken: usdt, receiptToken: { symbol: 'jUSDT', address: MAINNET_JUSDT_ADDRESS, decimals: 8 },
      baseRate: { kind: 'apr', rate: new Decimal(supplyRatePerBlockRaw).times(BLOCKS_PER_YEAR).div('1e18').toString() },
      reward: null, liquidity: { exitAvailable: new Decimal(cashRaw).div('1e6').toString(), withdrawalDelayDays: 0 },
      conversion: null, costs: [unknownCost('approval'), unknownCost('deposit'), unknownCost('withdraw'), unknownCost('network')],
      status: 'active', risks: ['현재 APR과 현금은 미래 지급일의 수익·출금을 보장하지 않습니다.',
        '채굴 인센티브와 실제 거래 비용은 별도 검증이 필요합니다.'], source: liveSource,
    });
    const diagnostics: QuoteDiagnostic[] = [{ checkId: 'justlend_jusdt', status: 'ready',
      reason: '공식 신규 공급 상태와 현재 Unitroller, 온체인 금리·현금을 확인했습니다.', source: liveSource }];
    if (!rateModel) diagnostics.push({ checkId: 'justlend_jusdt_rate_model', status: 'unknown',
      reason: '금리 모델 주소·코드·입력/출력의 현재 상태 대조가 완료되지 않아 금액 반영 후 금리는 미확인입니다.', source: liveSource });
    return { quote, evidence, diagnostics };
  } catch (error) {
    return { quote: null, evidence: null, diagnostics: [{ checkId: 'justlend_jusdt', status: 'unknown',
      reason: connectionReason(error, 'JustLend Mainnet jUSDT 온체인'), source }] };
  }
}
