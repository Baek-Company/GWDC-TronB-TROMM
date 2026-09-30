import type { DatedAllocation, EligibilityReason, Plan } from '../../../shared/schemas';

export type MonitorDiagnostic = {
  name: string;
  status: 'ready' | 'unknown' | 'unavailable';
  reason: string | null;
};

export type MonitorBlocker = { key: string; message: string };

type ProductKind = Exclude<Plan['kind'], 'hold'>;

const productName: Record<ProductKind, string> = {
  justlend_jusdt: 'JustLend jUSDT', psm_jusdd: 'PSM → JustLend jUSDD',
  justlend_jtrx: 'Nile JustLend jTRX',
};

const eligibilityGuidance: Record<EligibilityReason, string> = {
  needs_unconfirmed: '입력한 목표 조건을 다시 확인해 주세요.',
  chain_mismatch: '지갑과 상품의 네트워크를 일치시켜 주세요.',
  asset_mismatch: '지갑 자산과 상품 입력 자산을 확인해 주세요.',
  expense_asset_mismatch: '지출 자산과 운용 자산의 전환 경로를 확인해 주세요.',
  quote_unavailable: '상품 견적을 조회하지 못했습니다. 연결 상태를 확인하고 다시 평가해 주세요.',
  quote_stale: '상품 원천 갱신 시각이 확인되지 않거나 오래됐습니다. 최신 온체인 근거를 확인해 주세요.',
  non_live_data: '현재 실자료가 아니므로 라이브 자료가 확보된 뒤 다시 평가해 주세요.',
  market_inactive: '상품 시장이 비활성 상태입니다. 다른 경로를 검토해 주세요.',
  market_unknown: '시장 활성 상태를 온체인에서 확인해 주세요.',
  token_unverified: '시장 계약과 입출금 토큰 주소를 확인해 주세요.',
  rate_unavailable: '검증된 현재 수익률을 확보해야 합니다.',
  cost_unverified: '승인·예치·출금·네트워크 비용의 왕복 견적을 확인해야 합니다.',
  conversion_unverified: 'PSM 양방향 전환율과 토큰·출구를 확인해야 합니다.',
  entry_capacity_insufficient: 'PSM 진입 가능량을 확인하거나 금액을 줄여야 합니다.',
  exit_capacity_insufficient: 'PSM 출구 가능량을 확인하거나 금액을 줄여야 합니다.',
  liquidity_insufficient: '필요일에 필요한 시장 인출 유동성이 부족합니다.',
  withdrawal_delay: '필요일보다 앞서 환매할 수 있는 경로가 필요합니다.',
  usdd_risk_declined: 'USDD 위험을 수용하지 않는 조건입니다. 다른 상품을 검토해 주세요.',
  risk_preference: '현재 위험 성향에 맞는 상품을 검토해 주세요.',
  balance_unverified: '같은 네트워크의 TronLink 지갑을 연결하고 실잔액을 다시 조회해 주세요.',
  balance_insufficient: '실잔액으로 지출 보호액과 계획 운용액을 충당할 수 있는지 확인해 주세요.',
  fee_reserve_unverified: '거래 수수료용 TRX와 필요 리소스를 확인해 주세요.',
  fee_reserve_insufficient: '거래 수수료 예비액을 확보하거나 운용액을 줄여야 합니다.',
  zero_investable: '지출·예비액을 제외한 운용 가능액이 없습니다.',
  liquidity_unverified: '시장 출금 유동성과 지연 시간을 확인해야 합니다.',
};

const legGuidance: Record<string, string> = {
  due_today: '오늘 필요한 자금입니다. 먼저 지급 여부를 확인해 주세요.',
  non_positive_net_yield: '이 기간에는 비용 차감 후 이익이 없어 보유가 우선입니다.',
  aggregate_exit_or_conversion_capacity_insufficient: '여러 지출일을 합친 출구·전환 가능량을 확인해야 합니다.',
  amount_precision_unverified: '토큰 소수 자릿수에 맞게 금액을 확인해 주세요.',
  start_date_not_today: '운용 시작일을 오늘 기준으로 다시 평가해 주세요.',
};

function diagnosticProduct(name: string): ProductKind | null {
  if (name === 'justlend_rest') return null;
  if (name === 'justlend_jusdt') return 'justlend_jusdt';
  if (name === 'justlend_jusdd' || name === 'usdd_psm' || name === 'usdd_psm_capacity') return 'psm_jusdd';
  if (name === 'nile_jtrx' || /^nile_jtrx_\d+$/.test(name) || name === 'nile_jtrx_apy') return 'justlend_jtrx';
  return null;
}

function diagnosticMessage(diagnostic: MonitorDiagnostic): string | null {
  if (diagnostic.status === 'ready') return null;
  const product = diagnosticProduct(diagnostic.name);
  if (diagnostic.name !== 'justlend_rest' && product === null) return null;
  const label = diagnostic.name === 'justlend_rest' ? 'JustLend 시장 API'
    : diagnostic.name === 'usdd_psm' || diagnostic.name === 'usdd_psm_capacity' ? 'PSM 양방향 경로'
      : diagnostic.name === 'nile_jtrx_apy' ? 'Nile jTRX 연환산 수익률'
        : productName[product!];
  // Server diagnostics can contain provider text. Classify it, never render it verbatim.
  if (/\bHTTP 429\b/.test(diagnostic.reason ?? '')) {
    return `${label}: 조회 한도(HTTP 429)에 걸렸습니다. 잠시 후 다시 평가하고 서버의 API 키·호출량을 확인해 주세요.`;
  }
  if (/\bHTTP 401\b/.test(diagnostic.reason ?? '')) {
    return `${label}: 조회 인증을 확인해야 합니다. 서버의 API 키와 권한을 확인해 주세요.`;
  }
  if (/\bHTTP 403\b/.test(diagnostic.reason ?? '')) {
    return `${label}: 조회 접근이 제한됐습니다. 서버의 API 키·권한과 호출량을 확인해 주세요.`;
  }
  if (/시간이 초과|timeout/i.test(diagnostic.reason ?? '')) {
    return `${label}: 응답 시간이 초과됐습니다. 연결을 확인한 뒤 다시 평가해 주세요.`;
  }
  if (/DNS|ENOTFOUND/i.test(diagnostic.reason ?? '')) {
    return `${label}: 제공자 주소에 연결할 수 없습니다. 네트워크를 확인해 주세요.`;
  }
  if (diagnostic.name === 'usdd_psm_capacity') {
    return 'PSM 양방향 전환 가능량과 왕복 비용을 검증해야 합니다.';
  }
  if (diagnostic.name === 'nile_jtrx_apy') {
    return 'Nile 블록당 금리를 연환산할 검증된 기준이 필요합니다.';
  }
  return `${label}: ${diagnostic.status === 'unknown' ? '조건이 확인되지 않았습니다' : '조회할 수 없습니다'}. 원천 상태를 확인하고 다시 평가해 주세요.`;
}

function balanceMessage(reason: string | null, walletIssue: string | null): string | null {
  const value = reason ?? walletIssue;
  if (!value) return null;
  if (/연결.*(않|없)|주소.*(않|없)/.test(value)) {
    return '같은 네트워크의 TronLink 지갑을 연결하고 실잔액을 다시 조회해 주세요.';
  }
  if (/\bHTTP 429\b/.test(value)) {
    return '지갑 잔액 RPC 조회 한도(HTTP 429)에 걸렸습니다. 잠시 후 다시 평가하고 서버 API 키·호출량을 확인해 주세요.';
  }
  if (/부족|미치지 못/.test(value)) {
    return '지갑 실잔액이 지출 보호액에 부족합니다. 조건과 잔액을 다시 확인해 주세요.';
  }
  return '같은 네트워크·자산의 지갑 실잔액을 확인하지 못했습니다. 지갑 연결과 RPC 상태를 확인해 주세요.';
}

export function safeMonitorError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/\b(HTTP )?429\b/.test(message)) return '조회 한도(HTTP 429)에 걸렸습니다. 잠시 후 다시 시도해 주세요.';
  if (/\b(HTTP )?401\b/.test(message) || /세션이 만료/.test(message)) {
    return '에이전트 세션이 만료됐습니다. 화면을 새로고침해 주세요.';
  }
  if (/이미 도래한 지출|지난 지출/.test(message)) return '이미 도래한 지출의 지급 여부를 확인해 주세요.';
  if (/\b(HTTP )?422\b/.test(message)) return '확인한 계획 조건을 다시 점검해 주세요.';
  return '상품 또는 지갑 자료 조회에 실패했습니다. 연결 상태를 확인하고 다시 평가해 주세요.';
}

export function monitorBlockers(input: {
  originalPlan: Plan | null;
  originalAllocation: DatedAllocation | null;
  latestPlan: Plan | null;
  latestAllocation: DatedAllocation | null;
  diagnostics: MonitorDiagnostic[];
  balanceReason: string | null;
  walletIssue: string | null;
}): MonitorBlocker[] {
  const items: MonitorBlocker[] = [];
  const add = (key: string, message: string | null) => {
    if (message && !items.some(item => item.message === message)) items.push({ key, message });
  };
  const relevantProducts = new Set<ProductKind>();
  if (input.originalPlan && input.originalPlan.kind !== 'hold') relevantProducts.add(input.originalPlan.kind);
  if (input.originalAllocation) {
    for (const leg of input.originalAllocation.legs) if (leg.product) relevantProducts.add(leg.product);
    if (relevantProducts.size === 0) {
      for (const quote of input.originalAllocation.evaluatedQuotes) {
        if (quote.product in productName) relevantProducts.add(quote.product as ProductKind);
      }
    }
    if (relevantProducts.size === 0) {
      relevantProducts.add(input.originalAllocation.chain === 'nile' ? 'justlend_jtrx' : 'justlend_jusdt');
    }
  }
  const walletGuidance = balanceMessage(input.balanceReason, input.walletIssue);
  add('wallet', walletGuidance);
  if (input.latestPlan && input.latestPlan.kind !== 'hold') {
    for (const reason of input.latestPlan.eligibility.reasons) {
      add(`plan:${reason}`, `${productName[input.latestPlan.kind]}: ${eligibilityGuidance[reason]}`);
    }
  }
  if (input.latestAllocation) {
    for (const leg of input.latestAllocation.legs) {
      if (leg.eligibility !== 'unverified') continue;
      for (const reason of leg.reasons) {
        const guidance = reason in eligibilityGuidance
          ? eligibilityGuidance[reason as EligibilityReason] : legGuidance[reason];
        add(`leg:${leg.dueDate}:${reason}`, guidance ? `${leg.dueDate}: ${guidance}` : null);
      }
    }
  }
  for (const diagnostic of input.diagnostics) {
    const product = diagnosticProduct(diagnostic.name);
    if (diagnostic.name === 'justlend_rest'
      ? !relevantProducts.has('justlend_jusdt') && !relevantProducts.has('psm_jusdd')
      : !product || !relevantProducts.has(product)) continue;
    add(`source:${diagnostic.name}`, diagnosticMessage(diagnostic));
  }
  return items;
}
