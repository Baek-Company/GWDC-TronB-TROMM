import { TronWeb } from 'tronweb';
import type { Source, Token } from '../../shared/schemas';
import { connectionReason, type Chain } from '../data/provenance';
import { MAINNET_JUSDT_ADDRESS, MAINNET_UNITROLLER_ADDRESS } from '../data/quotes';
import type { MainnetJusdtMarketEvidence } from '../data/jusdt-market';
import { MAINNET_USDT_ADDRESS } from '../data/usdd';
import { MAINNET_RPC, NILE_JTRX_CANDIDATE, NILE_RPC, callConstant, decodeAddress,
  decodeUint, encodeAddress, readContract, readTrxBalance } from '../data/tron-rpc';
import { observeNileJtrxPosition, readNileWalletBalance } from '../transactions';

const TRX: Token = { symbol: 'TRX', address: null, decimals: 6 };
const USDT: Token = { symbol: 'USDT', address: MAINNET_USDT_ADDRESS, decimals: 6 };
const JTRX: Token = { symbol: 'jTRX', address: NILE_JTRX_CANDIDATE, decimals: 8 };
const JUSDT: Token = { symbol: 'jUSDT', address: MAINNET_JUSDT_ADDRESS, decimals: 8 };
const UINT = /^\d+$/;

export type PortfolioReadStatus = 'ready' | 'unknown' | 'unavailable';
export type PortfolioAmount = {
  status: PortfolioReadStatus;
  token: Token;
  amountBaseUnits: string | null;
  amount: string | null;
  source: Source | null;
  /** The balance RPC does not return the block at which it read the account. */
  blockNumber: null;
  reason: string | null;
};
export type PortfolioPosition = {
  status: PortfolioReadStatus;
  receiptToken: Token;
  receiptBalanceBaseUnits: string | null;
  receiptBalance: string | null;
  underlyingToken: Token;
  underlyingValueBaseUnits: string | null;
  underlyingValue: string | null;
  exchangeRateRaw: string | null;
  valuationMethod: 'exchangeRateCurrent_simulation' | null;
  marketVerified: boolean;
  source: Source | null;
  blockNumber: null;
  reason: string | null;
};
export type PortfolioSnapshot = {
  chain: Chain;
  walletAddress: string;
  observedAt: string;
  /** User input is retained separately and never presented as an on-chain reading. */
  declaredHoldings: { asset: string; amount: string } | null;
  walletBalance: PortfolioAmount;
  feeBalance: PortfolioAmount;
  position: PortfolioPosition;
  observedMinusDeclared: string | null;
  block: { number: null; status: 'unknown'; reason: string };
  consistency: 'independent_latest_reads';
  executionEligible: false;
};
export type PortfolioInput = {
  chain: Chain;
  address: string;
  declaredHoldings?: { asset: string; amount: string } | null;
  /** Reuse the same short-lived, version-bound market identity for a one-read USDT cap. */
  marketEvidence?: MainnetJusdtMarketEvidence;
  marketQuoteVersion?: string;
  /** Only used to link the existing Nile observation to a plan, not to authorize execution. */
  planId?: string;
};

type Dependencies = {
  nileBalance: typeof readNileWalletBalance;
  nilePosition: typeof observeNileJtrxPosition;
  contract: typeof readContract;
  constant: typeof callConstant;
  trxBalance: typeof readTrxBalance;
  now: () => number;
};

function normalizedAddress(input: string): string {
  if (!TronWeb.isAddress(input)) throw new Error('유효한 TRON 지갑 주소가 필요합니다.');
  return TronWeb.address.fromHex(TronWeb.address.toHex(input));
}

function sameAddress(a: string, b: string): boolean {
  return TronWeb.isAddress(a) && TronWeb.isAddress(b) &&
    TronWeb.address.toHex(a).toLowerCase() === TronWeb.address.toHex(b).toLowerCase();
}

function integer(raw: string, label: string): bigint {
  if (!UINT.test(raw)) throw new Error(`${label} 정수 응답을 확인할 수 없습니다.`);
  return BigInt(raw);
}

function units(raw: string, decimals: number): string {
  const value = integer(raw, '잔액');
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${value / scale}${fraction ? `.${fraction}` : ''}`;
}

function signedUnits(raw: bigint, decimals: number): string {
  return `${raw < 0n ? '-' : ''}${units((raw < 0n ? -raw : raw).toString(), decimals)}`;
}

function declaredBaseUnits(amount: string, decimals: number): bigint | null {
  if (!/^\d+(?:\.\d+)?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.split('.');
  if (whole.length > 78 || fraction.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

function source(chain: Chain, endpoint: string, now: () => number): Source {
  return { sourceUrl: `${chain === 'nile' ? NILE_RPC : MAINNET_RPC}${endpoint}`,
    chain, fetchedAt: new Date(now()).toISOString(), sourceUpdatedAt: null,
    mode: 'live', accessMethod: 'rpc' };
}

function unknownAmount(token: Token, reason: string, status: PortfolioReadStatus = 'unknown'): PortfolioAmount {
  return { status, token, amountBaseUnits: null, amount: null, source: null, blockNumber: null, reason };
}

function readyAmount(token: Token, raw: string, readSource: Source): PortfolioAmount {
  return { status: 'ready', token, amountBaseUnits: integer(raw, '잔액').toString(),
    amount: units(raw, token.decimals), source: readSource, blockNumber: null, reason: null };
}

function unknownPosition(chain: Chain, reason: string, status: PortfolioReadStatus = 'unknown'): PortfolioPosition {
  return { status, receiptToken: chain === 'nile' ? JTRX : JUSDT,
    receiptBalanceBaseUnits: null, receiptBalance: null,
    underlyingToken: chain === 'nile' ? TRX : USDT,
    underlyingValueBaseUnits: null, underlyingValue: null, exchangeRateRaw: null,
    valuationMethod: null, marketVerified: false, source: null, blockNumber: null, reason };
}

function mainnetPosition(receiptRaw: string, exchangeRaw: string, readSource: Source): PortfolioPosition {
  const receipt = integer(receiptRaw, 'jUSDT 잔액');
  const rate = integer(exchangeRaw, 'jUSDT 환율');
  if (rate === 0n) throw new Error('jUSDT 환율이 0입니다.');
  // JustLend jToken exchange-rate mantissa converts receipt base units to
  // underlying base units with a 1e18 divisor. This is a simulated current
  // valuation, not an executed redeem result.
  const underlying = receipt * rate / 10n ** 18n;
  return { status: 'ready', receiptToken: JUSDT, receiptBalanceBaseUnits: receipt.toString(),
    receiptBalance: units(receipt.toString(), JUSDT.decimals), underlyingToken: USDT,
    underlyingValueBaseUnits: underlying.toString(), underlyingValue: units(underlying.toString(), USDT.decimals),
    exchangeRateRaw: rate.toString(), valuationMethod: 'exchangeRateCurrent_simulation',
    marketVerified: true, source: readSource, blockNumber: null, reason: null };
}

/** Read-only observations. Each RPC call may see a different head block. */
export function createPortfolioObserver(overrides: Partial<Dependencies> = {}) {
  const d: Dependencies = {
    nileBalance: readNileWalletBalance, nilePosition: observeNileJtrxPosition,
    contract: readContract, constant: callConstant, trxBalance: readTrxBalance,
    now: Date.now, ...overrides,
  };

  return async function observePortfolio(input: PortfolioInput): Promise<PortfolioSnapshot> {
    if (input.chain !== 'nile' && input.chain !== 'mainnet') throw new Error('지원하지 않는 TRON 체인입니다.');
    const walletAddress = normalizedAddress(input.address);
    const declaredHoldings = input.declaredHoldings ?? null;
    const mainAsset = input.chain === 'nile' ? TRX : USDT;
    let walletBalance = unknownAmount(mainAsset, '지갑 잔액을 읽지 않았습니다.');
    let feeBalance = unknownAmount(TRX, '수수료용 TRX 잔액을 읽지 않았습니다.');
    let position = unknownPosition(input.chain, 'JustLend 포지션을 읽지 않았습니다.');

    if (input.chain === 'mainnet' && input.marketEvidence) {
      const market = input.marketEvidence;
      const time = d.now();
      const age = time - Date.parse(market.source.fetchedAt);
      const windowMs = Date.parse(market.observationWindow.endedAt)
        - Date.parse(market.observationWindow.startedAt);
      const blockSpan = /^\d+$/.test(market.observationWindow.lastBlock)
        && /^\d+$/.test(market.observationWindow.firstBlock)
        ? BigInt(market.observationWindow.lastBlock)
          - BigInt(market.observationWindow.firstBlock) : -1n;
      const valid = input.marketQuoteVersion === market.quoteVersion
        && sameAddress(market.marketAddress, MAINNET_JUSDT_ADDRESS)
        && sameAddress(market.underlyingAddress, MAINNET_USDT_ADDRESS)
        && sameAddress(market.controllerAddress, MAINNET_UNITROLLER_ADDRESS)
        && /^[0-9a-fA-F]{64}$/.test(market.marketCodeIdentity)
        && /^[0-9a-fA-F]{64}$/.test(market.underlyingCodeIdentity)
        && market.source.chain === 'mainnet' && market.source.mode === 'live'
        && market.source.accessMethod === 'rpc'
        && Number.isFinite(age) && age >= -5_000 && age <= 30_000
        && Number.isFinite(windowMs) && windowMs >= 0 && windowMs <= 30_000
        && blockSpan >= 0n && blockSpan <= 10n
        && Date.parse(market.validUntil) > time;
      try {
        if (!valid) throw new Error('시장 근거의 버전·코드·관측 범위가 일치하지 않습니다.');
        const raw = decodeUint(await d.constant('mainnet', MAINNET_USDT_ADDRESS,
          'balanceOf(address)', encodeAddress(walletAddress)));
        walletBalance = readyAmount(USDT, raw, source('mainnet', '/wallet/triggerconstantcontract', d.now));
      } catch (error) {
        walletBalance = unknownAmount(USDT, connectionReason(error, 'Mainnet USDT 금액별 잔액'));
      }
      feeBalance = unknownAmount(TRX, '금액별 읽기에서는 수수료용 TRX를 별도로 표시하지 않습니다.');
      position = unknownPosition('mainnet', '금액별 읽기에서는 기존 jUSDT 포지션을 별도로 표시하지 않습니다.');
      const declaredRaw = declaredHoldings?.asset === USDT.symbol
        ? declaredBaseUnits(declaredHoldings.amount, USDT.decimals) : null;
      const observedMinusDeclared = walletBalance.status === 'ready' && declaredRaw !== null
        ? signedUnits(BigInt(walletBalance.amountBaseUnits!) - declaredRaw, USDT.decimals) : null;
      return { chain: 'mainnet', walletAddress, observedAt: new Date(d.now()).toISOString(),
        declaredHoldings, walletBalance, feeBalance, position, observedMinusDeclared,
        block: { number: null, status: 'unknown',
          reason: '금액별 잔액은 Mainnet 최신 상수 조회이며 확정 블록에 결속되지 않았습니다.' },
        consistency: 'independent_latest_reads', executionEligible: false };
    }

    if (input.chain === 'nile') {
      try {
        const balance = await d.nileBalance(walletAddress);
        if (balance.chain !== 'nile' || !sameAddress(balance.walletAddress, walletAddress) ||
          balance.source.chain !== 'nile' || balance.source.mode !== 'live') {
          throw new Error('Nile 지갑 잔액의 체인 또는 주소가 일치하지 않습니다.');
        }
        walletBalance = readyAmount(TRX, balance.balanceSun, balance.source);
        feeBalance = walletBalance;
      } catch (error) {
        walletBalance = unknownAmount(TRX, connectionReason(error, 'Nile TRX 잔액'));
        feeBalance = walletBalance;
      }
      try {
        const observed = await d.nilePosition({ planId: input.planId || 'portfolio-read-only', address: walletAddress });
        if (observed.chain !== 'nile' || !sameAddress(observed.walletAddress, walletAddress) ||
          !sameAddress(observed.receiptToken.address ?? '', JTRX.address!) ||
          observed.receiptToken.decimals !== JTRX.decimals || observed.underlyingToken.symbol !== 'TRX' ||
          observed.underlyingToken.address !== null || observed.underlyingToken.decimals !== TRX.decimals ||
          observed.source.chain !== 'nile' || observed.source.mode !== 'live') {
          position = unknownPosition('nile', 'Nile jTRX 관측의 체인·계정·토큰이 일치하지 않습니다.', 'unavailable');
        } else {
          const receiptRaw = integer(observed.receiptBalanceBaseUnits, 'jTRX 잔액').toString();
          const underlyingRaw = integer(observed.underlyingValueBaseUnits, 'jTRX 기초 자산').toString();
          const rateRaw = integer(observed.exchangeRateRaw, 'jTRX 환율').toString();
          position = { status: 'ready', receiptToken: JTRX, receiptBalanceBaseUnits: receiptRaw,
            receiptBalance: units(receiptRaw, JTRX.decimals), underlyingToken: TRX,
            underlyingValueBaseUnits: underlyingRaw, underlyingValue: units(underlyingRaw, TRX.decimals),
            exchangeRateRaw: rateRaw, valuationMethod: 'exchangeRateCurrent_simulation',
            // The existing Nile observer checks a fixed candidate, but does not
            // prove market listing/code in this particular read.
            marketVerified: false, source: observed.source, blockNumber: null, reason: null };
        }
      } catch (error) {
        position = unknownPosition('nile', connectionReason(error, 'Nile jTRX 포지션'));
      }
    } else {
      // The TRX fee resource is separate from USDT and may remain readable when
      // the token contract is unavailable.
      try {
        const feeRaw = await d.trxBalance('mainnet', walletAddress);
        feeBalance = readyAmount(TRX, feeRaw, source('mainnet', '/wallet/getaccount', d.now));
      } catch (error) {
        feeBalance = unknownAmount(TRX, connectionReason(error, 'Mainnet 수수료용 TRX 잔액'));
      }

      let usdtVerified = false;
      try {
        const contract = await d.contract('mainnet', MAINNET_USDT_ADDRESS);
        const decimals = decodeUint(await d.constant('mainnet', MAINNET_USDT_ADDRESS, 'decimals()'));
        usdtVerified = contract.hasCode && sameAddress(contract.address, MAINNET_USDT_ADDRESS) && decimals === '6';
        if (!usdtVerified) {
          walletBalance = unknownAmount(USDT, 'Mainnet USDT 계약 코드·주소 또는 decimals(6)가 일치하지 않습니다.', 'unavailable');
        } else {
          const raw = decodeUint(await d.constant('mainnet', MAINNET_USDT_ADDRESS,
            'balanceOf(address)', encodeAddress(walletAddress)));
          walletBalance = readyAmount(USDT, raw, source('mainnet', '/wallet/triggerconstantcontract', d.now));
        }
      } catch (error) {
        walletBalance = unknownAmount(USDT, connectionReason(error, 'Mainnet USDT 잔액'));
      }

      if (!usdtVerified) {
        position = unknownPosition('mainnet', 'Mainnet USDT 계약을 검증하지 못해 jUSDT 포지션을 평가하지 않았습니다.');
      } else {
        try {
          const [market, controller, underlyingWord, comptrollerWord, receiptDecimalsWord] = await Promise.all([
            d.contract('mainnet', MAINNET_JUSDT_ADDRESS), d.contract('mainnet', MAINNET_UNITROLLER_ADDRESS),
            d.constant('mainnet', MAINNET_JUSDT_ADDRESS, 'underlying()'),
            d.constant('mainnet', MAINNET_JUSDT_ADDRESS, 'comptroller()'),
            d.constant('mainnet', MAINNET_JUSDT_ADDRESS, 'decimals()'),
          ]);
          const verified = market.hasCode && controller.hasCode &&
            sameAddress(market.address, MAINNET_JUSDT_ADDRESS) &&
            sameAddress(controller.address, MAINNET_UNITROLLER_ADDRESS) &&
            sameAddress(decodeAddress(underlyingWord), MAINNET_USDT_ADDRESS) &&
            sameAddress(decodeAddress(comptrollerWord), MAINNET_UNITROLLER_ADDRESS) &&
            decodeUint(receiptDecimalsWord) === '8' &&
            decodeUint(await d.constant('mainnet', MAINNET_UNITROLLER_ADDRESS,
              'markets(address)', encodeAddress(MAINNET_JUSDT_ADDRESS))) === '1';
          if (!verified) {
            position = unknownPosition('mainnet', 'Mainnet jUSDT 계약·기초 자산·decimals(8) 또는 활성 시장이 일치하지 않습니다.', 'unavailable');
          } else {
            const [receiptWord, exchangeWord] = await Promise.all([
              d.constant('mainnet', MAINNET_JUSDT_ADDRESS, 'balanceOf(address)', encodeAddress(walletAddress)),
              d.constant('mainnet', MAINNET_JUSDT_ADDRESS, 'exchangeRateCurrent()'),
            ]);
            position = mainnetPosition(decodeUint(receiptWord), decodeUint(exchangeWord),
              source('mainnet', '/wallet/triggerconstantcontract', d.now));
          }
        } catch (error) {
          position = unknownPosition('mainnet', connectionReason(error, 'Mainnet jUSDT 포지션'));
        }
      }
    }

    const declaredRaw = declaredHoldings?.asset === mainAsset.symbol
      ? declaredBaseUnits(declaredHoldings.amount, mainAsset.decimals) : null;
    const observedMinusDeclared = walletBalance.status === 'ready' && declaredRaw !== null
      ? signedUnits(BigInt(walletBalance.amountBaseUnits!) - declaredRaw, mainAsset.decimals) : null;
    return { chain: input.chain, walletAddress, observedAt: new Date(d.now()).toISOString(),
      declaredHoldings, walletBalance, feeBalance, position, observedMinusDeclared,
      block: { number: null, status: 'unknown',
        reason: '계정·상수 호출 응답에 적용 블록 번호가 없어 관측값을 하나의 블록 또는 solidified 상태에 결속할 수 없습니다.' },
      consistency: 'independent_latest_reads', executionEligible: false };
  };
}

export const observePortfolio = createPortfolioObserver();
