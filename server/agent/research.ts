import Decimal from 'decimal.js';
import { TronWeb } from 'tronweb';
import { JUSTLEND_URL, readMarkets } from '../data';
import { connectionReason } from '../data/provenance';
import { readNileQuote } from '../data/quotes';
import { NILE_RPC } from '../data/tron-rpc';
import { MAINNET_USDD_ADDRESS, MAINNET_USDT_ADDRESS, readMainnetPsmEvidence } from '../data/usdd';
import type { MarketSnapshot } from '../../shared/markets';

export type ResearchTopic = 'lending_rate' | 'market_liquidity' | 'psm_exit' | 'network_comparison' | 'spot_price' | 'unsupported';
export type ResearchAvailability = 'ready' | 'unknown' | 'unavailable';
export type ResearchStatus = 'ready' | 'partial' | 'unavailable' | 'needs_clarification' | 'unsupported';
export type ResearchSource = {
  sourceUrl: string;
  chain: 'mainnet' | 'nile' | 'cross_network';
  fetchedAt: string | null;
  /** A failed request has an attempt time, never a successful fetch time. */
  attemptedAt?: string;
  sourceUpdatedAt: string | null;
  mode: 'live' | 'snapshot' | 'synthetic' | 'documentation' | 'unavailable';
  accessMethod: 'rest' | 'rpc' | 'docs';
};
export type ResearchClaim = {
  label: string;
  value: string | null;
  unit: string | null;
  availability: ResearchAvailability;
  useScope: 'display' | 'planning' | 'execution';
  source: ResearchSource | null;
  note: string | null;
};
export type ResearchResult = {
  question: string;
  topic: ResearchTopic;
  status: ResearchStatus;
  conclusion: string;
  claims: ResearchClaim[];
  unavailable: string[];
  planningImpact: string;
  followUpQuestion: string | null;
};
export type MarketResearchReport = { status: 'ready' | 'partial' | 'unavailable'; results: ResearchResult[] };

type ResearchDependencies = {
  markets: typeof readMarkets;
  nileQuote: typeof readNileQuote;
  psm: typeof readMainnetPsmEvidence;
  fetchPrice: typeof fetch;
  now: () => number;
};
const defaults: ResearchDependencies = {
  markets: readMarkets, nileQuote: readNileQuote, psm: readMainnetPsmEvidence,
  fetchPrice: fetch, now: Date.now,
};
const SUN_PRICE_URL = 'https://open.sun.io/apiv2/price';
const TRON_NETWORKS_DOC = 'https://developers.tron.network/docs/networks';
const TRON_TEST_TOKEN_DOC = 'https://developers.tron.network/docs/getting-testnet-tokens-on-tron';

function sourceFromMarket(snapshot: MarketSnapshot): ResearchSource {
  return { sourceUrl: snapshot.source, chain: 'mainnet', fetchedAt: snapshot.fetchedAt,
    sourceUpdatedAt: snapshot.sourceUpdatedAt, mode: snapshot.mode, accessMethod: 'rest' };
}

function attemptedSource(url: string, chain: 'mainnet' | 'nile', method: 'rest' | 'rpc', now: number): ResearchSource {
  return { sourceUrl: url, chain, fetchedAt: null, attemptedAt: new Date(now).toISOString(),
    sourceUpdatedAt: null, mode: 'unavailable', accessMethod: method };
}

function fetchedSource(url: string, chain: 'mainnet' | 'nile', method: 'rest' | 'rpc', now: number): ResearchSource {
  return { sourceUrl: url, chain, fetchedAt: new Date(now).toISOString(), sourceUpdatedAt: null,
    mode: 'live', accessMethod: method };
}

function claim(label: string, value: string | null, unit: string | null,
  availability: ResearchAvailability, source: ResearchSource | null, note: string | null): ResearchClaim {
  // A research response never grants a quote permission to drive a trade.
  return { label, value, unit, availability, useScope: 'display', source, note };
}

function unavailable(question: string, topic: ResearchTopic, message: string,
  source: ResearchSource | null = null): ResearchResult {
  return { question, topic, status: 'unavailable', conclusion: '현재 확인할 수 없습니다.',
    claims: source ? [claim('조회 상태', null, null, 'unavailable', source, message)] : [],
    unavailable: [message], planningImpact: '이 조사만으로 계획 후보를 실행 가능으로 판정하지 않습니다.',
    followUpQuestion: null };
}

function classifyTopics(question: string): ResearchTopic[] {
  const value = question.toLowerCase();
  const topics: { topic: ResearchTopic; index: number }[] = [];
  const add = (topic: ResearchTopic, match: RegExpMatchArray | null) => {
    if (match) topics.push({ topic, index: match.index ?? 0 });
  };
  const hasNetworkComparison = /(nile|나일)/.test(value) && /(mainnet|메인넷)/.test(value);
  const hasPsmExit = /(psm|usdd)/.test(value) && /(출구|환매|상환|되돌|교환|전환|유동성|가능|상태|exit)/.test(value);
  if (hasNetworkComparison) add('network_comparison', value.match(/nile|나일|mainnet|메인넷/));
  if (hasPsmExit) add('psm_exit', value.match(/출구|환매|상환|되돌|교환|전환|유동성|가능|상태|exit/));
  add('lending_rate', value.match(/금리|이자|apy|apr|수익률|rate/));
  // "USDD 출구 유동성" is a PSM question, not an unrelated JustLend cash query.
  if (!hasPsmExit || /justlend|저스트렌드/i.test(value)) {
    add('market_liquidity', value.match(/유동성|현금|cash|liquidity/));
  }
  add('spot_price', value.match(/가격|시세|달러|\busd\b|price/));
  return topics.sort((a, b) => a.index - b.index).map(item => item.topic);
}

function topicClause(question: string, topic: ResearchTopic): string {
  if (topic === 'network_comparison') return question;
  const marker = topic === 'lending_rate' ? /금리|이자|apy|apr|수익률|rate/i
    : topic === 'market_liquidity' ? /유동성|현금|cash|liquidity/i
      : topic === 'spot_price' ? /가격|시세|달러|\busd\b|price/i : /출구|환매|상환|되돌|교환|전환|가능|상태|exit/i;
  const parts = question.split(/(?:와|과)\s+|\s+(?:그리고|및)\s+/);
  const index = parts.findIndex(value => marker.test(value));
  if (index < 0) return question;
  // In “USDT와 USDD 시세”, the price marker occurs only in the second clause.
  // Retain the first token when it is an unqualified token name, but do not
  // pull in a different topic such as “USDT 금리와 USDD 시세”.
  if (topic === 'spot_price' && index > 0 &&
    /(?:^|\s)(?:usdt|usdd)\s*$/i.test(parts[index - 1]) &&
    !/금리|이자|apy|apr|수익률|rate|가격|시세|달러|price/i.test(parts[index - 1])) {
    return `${parts[index - 1]} ${parts[index]}`;
  }
  return parts[index];
}

function requestedMarkets(question: string): ('jUSDT' | 'jUSDD' | 'jTRX')[] {
  const value = question.toLowerCase();
  const markets: ('jUSDT' | 'jUSDD' | 'jTRX')[] = [];
  if (/usdt/.test(value)) markets.push('jUSDT');
  if (/usdd/.test(value)) markets.push('jUSDD');
  if (/trx/.test(value)) markets.push('jTRX');
  return markets.length ? markets : ['jUSDT', 'jUSDD', 'jTRX'];
}

async function lendingOrLiquidity(question: string, topic: 'lending_rate' | 'market_liquidity',
  deps: ResearchDependencies): Promise<ResearchResult> {
  const selected = requestedMarkets(topicClause(question, topic));
  const nileOnly = /(nile|나일)/i.test(question) && !/(mainnet|메인넷)/i.test(question);
  if (nileOnly) {
    if (!selected.includes('jTRX') || selected.length !== 1) {
      return unavailable(question, topic, 'Nile 조사는 현재 jTRX 시장만 지원합니다.');
    }
    let nile: Awaited<ReturnType<typeof readNileQuote>>;
    try { nile = await deps.nileQuote(); }
    catch (error) { return unavailable(question, topic, connectionReason(error, 'Nile jTRX RPC'),
      attemptedSource(`${NILE_RPC}/wallet/triggerconstantcontract`, 'nile', 'rpc', deps.now())); }
    const quote = nile.jTrx;
    const source = quote ? { ...quote.source, chain: 'nile' as const, accessMethod: 'rpc' as const } : null;
    if (!quote) return unavailable(question, topic,
      nile.diagnostics.map(item => item.reason).join('; ') || 'Nile jTRX 조회 실패',
      attemptedSource(`${NILE_RPC}/wallet/triggerconstantcontract`, 'nile', 'rpc', deps.now()));
    if (quote.source.mode !== 'live') {
      return unavailable(question, topic, 'Nile jTRX 자료가 live 조회가 아니므로 현재 시장 상태로 제시하지 않습니다.', source);
    }
    if (topic === 'lending_rate') return {
      question, topic, status: 'partial', conclusion: 'Nile jTRX의 검증된 연환산 공급 금리는 현재 제공할 수 없습니다.',
      claims: [claim('Nile jTRX 공급 금리', null, '% APY', 'unknown', source,
        '블록당 금리를 연환산할 검증된 블록 시간 기준이 없습니다.')],
      unavailable: nile.diagnostics.map(item => item.reason), planningImpact: 'Nile 금리와 Mainnet 금리를 같은 투자 수익으로 비교하지 않습니다.',
      followUpQuestion: null,
    };
    return { question, topic, status: quote.liquidity.exitAvailable === null ? 'partial' : 'ready',
      conclusion: 'Nile 시험망 jTRX의 계약 조회 결과입니다. 실제 환매 성공이나 Mainnet 유동성을 뜻하지 않습니다.',
      claims: [claim('Nile jTRX 계약 보유 TRX', quote.liquidity.exitAvailable, 'TRX',
        quote.liquidity.exitAvailable === null ? 'unknown' : 'ready', source, '시험망 계약 현금이며 사용자별 인출 가능액이 아닙니다.')],
      unavailable: nile.diagnostics.map(item => item.reason), planningImpact: '시험망 현금 잔고만으로 실행 가능 환매 수량을 확정하지 않습니다.',
      followUpQuestion: null };
  }

  let snapshot: MarketSnapshot;
  try { snapshot = await deps.markets(); }
  catch (error) {
    const normalized = error instanceof Error && /^JustLend HTTP \d{3}$/.test(error.message)
      ? new Error(error.message.slice('JustLend '.length)) : error;
    return unavailable(question, topic, connectionReason(normalized, 'JustLend 시장 API'),
      attemptedSource(JUSTLEND_URL, 'mainnet', 'rest', deps.now()));
  }
  const source = sourceFromMarket(snapshot);
  const claims = selected.map(symbol => {
    const market = snapshot.markets.find(item => item.symbol === symbol);
    if (!market) return claim(`${symbol} ${topic === 'lending_rate' ? '공급 금리' : '시장 현금'}`,
      null, topic === 'lending_rate' ? '% APY' : symbol.slice(1), 'unavailable', source, '시장 목록에 없습니다.');
    if (topic === 'lending_rate') return claim(`${symbol} 표시 공급 금리`,
      new Decimal(market.supplyRate).times(100).toString(), '% APY', 'unknown', source,
      'JustLend V1 REST는 원천 갱신 시각이 없고 보상 채굴 금리는 포함하지 않습니다.');
    return claim(`${symbol} 시장 현금`, market.cash, market.underlyingSymbol, 'unknown', source,
      '시장 전체 잔고이며 사용자별 실제 인출 가능액과 원천 갱신 시각은 확인되지 않았습니다.');
  });
  const missing = claims.filter(item => item.availability === 'unavailable').map(item => `${item.label}: 시장 목록에 없음`);
  missing.push('JustLend V1 REST 원천 갱신 시각 미제공');
  return { question, topic, status: 'partial',
    conclusion: topic === 'lending_rate'
      ? 'JustLend가 반환한 표시 공급 금리입니다. 원천 갱신 시각이 없어 현재 실행 금리로 확정할 수 없습니다.'
      : 'JustLend가 반환한 시장 현금입니다. 사용자별 출구 유동성은 별도 확인이 필요합니다.',
    claims, unavailable: missing, planningImpact: '표시값은 참고용이며 최신 실행 견적·왕복 비용·출구 검증을 대체하지 않습니다.',
    followUpQuestion: null };
}

async function psmExit(question: string, deps: ResearchDependencies): Promise<ResearchResult> {
  let result: Awaited<ReturnType<typeof readMainnetPsmEvidence>>;
  try { result = await deps.psm(); }
  catch (error) { return unavailable(question, 'psm_exit', connectionReason(error, 'USDD PSM RPC'),
    attemptedSource('https://api.trongrid.io/wallet/triggerconstantcontract', 'mainnet', 'rpc', deps.now())); }
  const source = { ...result.source, chain: 'mainnet' as const, accessMethod: 'rpc' as const };
  if (result.status !== 'ready') return unavailable(question, 'psm_exit', result.reason,
    attemptedSource(result.source.sourceUrl, 'mainnet', 'rpc', deps.now()));
  const psm = result.value;
  const claims = [
    claim('PSM USDD→USDT 출구 스위치', psm.exitEnabled ? '활성' : '비활성', null, 'ready', source,
      '스위치 활성은 요청 금액의 실제 상환 가능성을 보증하지 않습니다.'),
    claim('PSM 출구 수수료율', psm.exitFeeRate, '비율', 'ready', source, '0.01은 1%입니다. 왕복 총비용은 아닙니다.'),
    claim('PSM 출력 USDD와 jUSDD 기초자산 일치', psm.tokenCompatible === null ? null : String(psm.tokenCompatible), null,
      psm.tokenCompatible === null ? 'unknown' : 'ready', source, '주소 일치 여부만 확인합니다.'),
    claim('USDD→USDT 사용 가능 출구 용량', psm.exitCapacity, 'USDT', 'unknown', source,
      '계약 스위치와 별개로 수량별 용량·실수령액은 미확인입니다.'),
  ];
  return { question, topic: 'psm_exit', status: 'partial',
    conclusion: psm.exitEnabled
      ? '출구 기능의 활성 상태는 확인됐지만, 요청 수량의 실제 USDT 상환 가능성과 왕복 비용은 확인되지 않았습니다.'
      : 'USDD→USDT 출구가 비활성 상태로 조회됐습니다.',
    claims, unavailable: psm.missing, planningImpact: 'PSM 출구 용량·실출력·비용 검증 전에는 USDD 경로를 거래 가능 계획으로 추천하지 않습니다.',
    followUpQuestion: null };
}

function networkComparison(question: string): ResearchResult {
  const source: ResearchSource = { sourceUrl: TRON_NETWORKS_DOC, chain: 'cross_network',
    fetchedAt: null, sourceUpdatedAt: null, mode: 'documentation', accessMethod: 'docs' };
  const tokenSource: ResearchSource = { ...source, sourceUrl: TRON_TEST_TOKEN_DOC };
  return { question, topic: 'network_comparison', status: 'ready',
    conclusion: 'Mainnet은 실제 자산이 거래되는 운영망이고 Nile은 기능·파라미터를 시험하는 별도 테스트망입니다.',
    claims: [
      claim('Mainnet 용도', '실제 TRX가 거래되는 운영망', null, 'ready', source, '이것은 네트워크 구조 설명이며 현재 시세가 아닙니다.'),
      claim('Nile 용도', '테스트용 별도 네트워크', null, 'ready', source, 'Nile 코드·파라미터는 Mainnet과 다를 수 있습니다.'),
      claim('Nile 시험 토큰', '실자산 가치 없음', null, 'ready', tokenSource, '시험 토큰의 거래 결과를 실제 수익으로 해석하지 않습니다.'),
    ],
    unavailable: ['각 네트워크의 현재 금리·가스·계약 상태는 이 구조 설명에서 조회하지 않았습니다.'],
    planningImpact: 'Nile 견적·거래 성공을 Mainnet 실행 적격성이나 수익성 근거로 사용하지 않습니다.',
    followUpQuestion: null };
}

type PriceToken = { symbol: 'USDT' | 'USDD'; address: string };

function priceTokens(question: string): PriceToken[] {
  const clause = topicClause(question, 'spot_price');
  const selected: PriceToken[] = [];
  if (/usdt/i.test(clause)) selected.push({ symbol: 'USDT', address: MAINNET_USDT_ADDRESS });
  if (/usdd/i.test(clause)) selected.push({ symbol: 'USDD', address: MAINNET_USDD_ADDRESS });
  return selected;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function spotPrice(question: string, deps: ResearchDependencies, readBudget = 2): Promise<ResearchResult> {
  const tokens = priceTokens(question);
  if (tokens.length === 0) return { question, topic: 'spot_price', status: 'needs_clarification',
    conclusion: '조회할 토큰을 특정해 주세요.', claims: [], unavailable: [],
    planningImpact: '가격 조사만으로 거래 제안은 만들지 않습니다.', followUpQuestion: 'USDT와 USDD 중 어느 토큰의 USD 현물 가격을 조회할까요?' };
  const claims: ResearchClaim[] = [];
  const unavailableItems: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (index >= readBudget) {
      const reason = '한 요청의 외부 조사 상한(5개)에 도달했습니다. 이 토큰을 별도로 다시 질문해 주세요.';
      claims.push(claim(`${token.symbol} USD 현물 가격`, null, 'USD', 'unavailable', null, reason));
      unavailableItems.push(`${token.symbol}: ${reason}`);
      continue;
    }
    const url = new URL(SUN_PRICE_URL);
    url.searchParams.set('tokenAddress', token.address);
    try {
      const headers: Record<string, string> = {};
      if (process.env.SUN_API_KEY) headers['X-API-KEY'] = process.env.SUN_API_KEY;
      const response = await deps.fetchPrice(url, { headers, signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const envelope = object(await response.json());
      const data = object(envelope?.data);
      if (envelope?.code !== 0 || !data) throw new Error('SUN price schema');
      const key = Object.keys(data).find(value => TronWeb.isAddress(value) &&
        TronWeb.address.toHex(value).toLowerCase() === TronWeb.address.toHex(token.address).toLowerCase());
      const usd = object(object(object(key ? data[key] : null)?.quote)?.USD);
      const rawPrice = usd?.price;
      const updated = usd?.last_updated;
      if (typeof rawPrice !== 'string' || !/^\d+(?:\.\d+)?$/.test(rawPrice)
        || !new Decimal(rawPrice).gt(0) || typeof updated !== 'number' || !Number.isSafeInteger(updated)) {
        throw new Error('SUN price schema');
      }
      const updatedIso = new Date(updated).toISOString();
      const fetched = fetchedSource(url.toString(), 'mainnet', 'rest', deps.now());
      fetched.sourceUpdatedAt = updatedIso;
      const age = deps.now() - updated;
      if (age < -300_000 || age > 900_000) {
        claims.push(claim(`${token.symbol} USD 현물 가격`, null, 'USD', 'unknown', fetched,
          `원천 갱신 시각: ${updatedIso}; 현재 가격으로 사용할 수 없습니다.`));
        unavailableItems.push(`${token.symbol}: 신선한 USD 현물 가격`);
      } else {
        claims.push(claim(`${token.symbol} USD 현물 가격`, rawPrice, 'USD', 'ready', fetched,
          '금액별 교환 실출력, 수수료, 슬리피지를 포함하지 않습니다.'));
      }
    } catch (error) {
      const reason = connectionReason(error, 'SUN 가격 API');
      claims.push(claim(`${token.symbol} USD 현물 가격`, null, 'USD', 'unavailable',
        attemptedSource(url.toString(), 'mainnet', 'rest', deps.now()), reason));
      unavailableItems.push(`${token.symbol}: ${reason}`);
    }
  }
  const allReady = claims.every(item => item.availability === 'ready');
  const allUnavailable = claims.every(item => item.availability === 'unavailable');
  return { question, topic: 'spot_price', status: allReady ? 'ready' : allUnavailable ? 'unavailable' : 'partial',
    conclusion: allReady ? `SUN이 반환한 ${tokens.map(token => token.symbol).join('·')}의 USD 현물 참고 가격입니다.`
      : allUnavailable ? '현재 확인할 수 없습니다.' : '일부 토큰의 신선한 USD 현물 가격을 확인할 수 없습니다.',
    claims, unavailable: [...unavailableItems, '수량별 실제 교환 실출력·왕복 비용'],
    planningImpact: '현물 참고 가격은 수량별 견적이나 실행 적격성으로 승격하지 않습니다.', followUpQuestion: null };
}

async function researchTopic(question: string, topic: ResearchTopic, deps: ResearchDependencies): Promise<ResearchResult> {
  if (topic === 'lending_rate' || topic === 'market_liquidity') return lendingOrLiquidity(question, topic, deps);
  if (topic === 'psm_exit') return psmExit(question, deps);
  if (topic === 'network_comparison') return networkComparison(question);
  if (topic === 'spot_price') return spotPrice(question, deps);
  return { question, topic: 'unsupported', status: 'unsupported',
    conclusion: '현재 지원하는 TRON 시장 조사 범위 밖의 질문입니다.', claims: [],
    unavailable: ['현재 JustLend 금리·시장 현금, USDD PSM 출구, Nile/Mainnet 차이, USDT/USDD 현물 USD 가격을 조회할 수 있습니다.'],
    planningImpact: '지원되지 않는 답을 추정하여 계획에 넣지 않습니다.', followUpQuestion: null };
}

export async function researchMarketQuestion(question: string,
  overrides: Partial<ResearchDependencies> = {}): Promise<ResearchResult> {
  const deps = { ...defaults, ...overrides };
  const normalized = question.trim();
  if (!normalized) return { question, topic: 'unsupported', status: 'needs_clarification',
    conclusion: '조사할 질문을 알려주세요.', claims: [], unavailable: [],
    planningImpact: '시장 조사가 거래 권한을 생성하지 않습니다.', followUpQuestion: '어떤 시장 정보를 조사해 드릴까요?' };
  return researchTopic(normalized, classifyTopics(normalized)[0] ?? 'unsupported', deps);
}

export async function researchMarketQuestions(questions: string[],
  overrides: Partial<ResearchDependencies> = {}): Promise<MarketResearchReport> {
  const deps = { ...defaults, ...overrides };
  let remoteBudget = 5;
  const tasks = questions.flatMap(question => {
    const normalized = question.trim();
    const topics = classifyTopics(normalized);
    if (topics.length === 0) return [researchMarketQuestion(question, overrides)];
    return topics.map(topic => {
      if (topic === 'network_comparison') return Promise.resolve(networkComparison(normalized));
      if (topic === 'spot_price') {
        const count = priceTokens(normalized).length;
        const allowed = Math.min(remoteBudget, count);
        remoteBudget -= allowed;
        return spotPrice(normalized, deps, allowed);
      }
      if (remoteBudget === 0) return Promise.resolve(unavailable(normalized, topic,
        '한 요청의 외부 조사 상한(5개)에 도달했습니다. 이 주제를 별도로 다시 질문해 주세요.'));
      remoteBudget--;
      return researchTopic(normalized, topic, deps);
    });
  });
  const results = await Promise.all(tasks);
  const status = results.length > 0 && results.every(item => item.status === 'ready') ? 'ready'
    : results.some(item => ['ready', 'partial'].includes(item.status)) ? 'partial' : 'unavailable';
  return { status, results };
}
