import { TronWeb } from 'tronweb';
import { readMarkets, readNileBlock, JUSTLEND_URL, NILE_RPC } from '../server/data';
import { connectionReason, type Availability, type Chain } from '../server/data/provenance';
import { MAINNET_RPC, NILE_JTRX_CANDIDATE, NILE_JTRX_SOURCE, readNileJtrxProbe } from '../server/data/tron-rpc';
import { readMainnetPsmEvidence, USDD_PSM_ADDRESS_SOURCE } from '../server/data/usdd';
import { inspectOfficialMcp, readJustLendMcpMarket, JUSTLEND_MCP_DOCS, USDD_MCP_DOCS } from '../server/mcp/registry';
import { readTronGridMcp, TRONGRID_MCP_DOCS } from '../server/mcp/trongrid';
import { readStake2Alternative, readSunStablecoinAlternative } from '../server/data/alternatives';
import { readMainnetJusdtMarket } from '../server/data/jusdt-market';
import { conversationCapability } from '../server/llm/conversation';

export type DoctorCheck = {
  checkId: string;
  status: Availability;
  reason: string;
  source: string;
  chain: Chain | null;
  checkedAt: string;
};

function check(checkId: string, status: Availability, reason: string, source: string, chain: Chain | null): DoctorCheck {
  return { checkId, status, reason, source, chain, checkedAt: new Date().toISOString() };
}

export async function runDoctor(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push(check('node24', process.versions.node.startsWith('24.') ? 'ready' : 'unavailable',
    process.versions.node.startsWith('24.') ? 'Node.js 24 실행 중' : 'Node.js 24가 필요합니다.', 'https://nodejs.org/', null));
  checks.push(check('trongrid_key_configured', process.env.TRONGRID_API_KEY ? 'ready' : 'unknown',
    process.env.TRONGRID_API_KEY ? 'TronGrid 키 설정됨; 실제 호출은 별도 확인' : 'TronGrid 키 미설정; 공개 읽기 시도',
    'https://developers.tron.network/reference/select-network', null));
  checks.push(check('nim_key_configured', process.env.NVIDIA_API_KEY ? 'ready' : 'unknown',
    process.env.NVIDIA_API_KEY ? 'NIM 서버 키 설정됨; 실제 모델 응답은 미검증' : 'NIM 서버 키 미설정',
    'https://docs.api.nvidia.com/nim/reference/llm-apis', null));
  checks.push(check('nim_model_configured', 'ready',
    `${conversationCapability().model} 앱 모델 ID 설정됨; 실제 모델 응답은 별도 검증 필요`,
    'https://docs.api.nvidia.com/nim/reference/llm-apis', null));

  // Probe the direct Mainnet market path before the other parallel provider checks.
  // Report only evidence readiness; rates, balances, and credentials stay out of doctor output.
  try {
    const market = await readMainnetJusdtMarket();
    const quoteReady = market.quote !== null && market.evidence !== null;
    const modelReady = quoteReady && market.evidence?.rateModel !== null;
    const unavailable = market.diagnostics.some(item =>
      item.checkId === 'justlend_jusdt' && item.status === 'unavailable');
    checks.push(check('justlend_jusdt_rpc', modelReady ? 'ready' : unavailable ? 'unavailable' : 'unknown',
      modelReady ? 'Mainnet jUSDT 온체인 시세와 금액별 금리 모델 검증 완료'
        : quoteReady ? 'Mainnet jUSDT 온체인 시세 확인; 금액별 금리 모델 미검증'
          : unavailable ? 'Mainnet jUSDT 신규 공급 상태가 비활성 또는 계약 상태가 불일치합니다.'
            : 'Mainnet jUSDT 온체인 시세 또는 금리 모델을 확인하지 못했습니다.',
      MAINNET_RPC, 'mainnet'));
  } catch {
    checks.push(check('justlend_jusdt_rpc', 'unknown',
      'Mainnet jUSDT 온체인 시세 또는 금리 모델 조회 중 오류가 발생했습니다.', MAINNET_RPC, 'mainnet'));
  }

  const publicWallet = process.env.NILE_WALLET_ADDRESS;
  const wallet = publicWallet && TronWeb.isAddress(publicWallet) ? publicWallet : undefined;
  const [markets, block, mcp, psm, nile, staking, sun] = await Promise.allSettled([
    readMarkets(true), readNileBlock(), inspectOfficialMcp(), readMainnetPsmEvidence(), readNileJtrxProbe(wallet),
    readStake2Alternative(), readSunStablecoinAlternative(),
  ]);
  checks.push(markets.status === 'fulfilled'
    ? check('justlend_rest', 'ready', `${markets.value.markets.length}개 Mainnet 시장 응답·스키마 확인`, JUSTLEND_URL, 'mainnet')
    : check('justlend_rest', 'unavailable', connectionReason(markets.reason, 'JustLend REST'), JUSTLEND_URL, 'mainnet'));
  checks.push(block.status === 'fulfilled'
    ? check('nile_block', 'ready', `Nile 블록 ${block.value.block} 조회`, NILE_RPC, 'nile')
    : check('nile_block', 'unavailable', connectionReason(block.reason, 'Nile RPC'), NILE_RPC, 'nile'));

  if (mcp.status === 'fulfilled') {
    const { justlend, usdd, trongrid } = mcp.value;
    checks.push(check('justlend_mcp_tools', justlend.status,
      justlend.status === 'ready' ? `읽기 허용 도구: ${justlend.value.toolNames.join(', ') || '없음'}` : justlend.reason,
      JUSTLEND_MCP_DOCS, 'mainnet'));
    checks.push(check('usdd_mcp_startup', usdd.status,
      usdd.status === 'ready' ? 'USDD MCP 상태 검증 누락' : usdd.reason, USDD_MCP_DOCS, 'mainnet'));
    if (justlend.status === 'ready' && justlend.value.toolNames.includes('get_market_data')) {
      const called = await readJustLendMcpMarket('jUSDT', 'mainnet');
      checks.push(check('justlend_mcp_read', called.status,
        called.status === 'ready' ? 'jUSDT Mainnet 읽기 도구 호출 성공' : called.reason,
        JUSTLEND_MCP_DOCS, 'mainnet'));
    } else checks.push(check('justlend_mcp_read', 'unavailable', '앱 서버에서 읽기 도구를 확인하지 못했습니다.', JUSTLEND_MCP_DOCS, 'mainnet'));
    checks.push(check('trongrid_mcp_tools', trongrid.status,
      trongrid.status === 'ready' ? `공식 API 조회 허용 도구: ${trongrid.value.toolNames.join(', ')}` : trongrid.reason,
      TRONGRID_MCP_DOCS, 'mainnet'));
    if (trongrid.status === 'ready' && trongrid.value.toolNames.includes('getEventsByLatestBlock')) {
      const called = await readTronGridMcp('getEventsByLatestBlock', {});
      checks.push(check('trongrid_mcp_read', called.status,
        called.status === 'ready' ? 'Mainnet 조회 도구 호출 성공; 응답 내용 스키마와 수치는 별도 검증 필요' : called.reason,
        TRONGRID_MCP_DOCS, 'mainnet'));
    } else checks.push(check('trongrid_mcp_read', 'unknown', '공식 MCP 조회 도구 호출 미확인', TRONGRID_MCP_DOCS, 'mainnet'));
  } else {
    checks.push(check('justlend_mcp_tools', 'unavailable', '도구 목록 조회 실패', JUSTLEND_MCP_DOCS, 'mainnet'));
    checks.push(check('justlend_mcp_read', 'unavailable', '읽기 호출 미확인', JUSTLEND_MCP_DOCS, 'mainnet'));
    checks.push(check('usdd_mcp_startup', 'unavailable', '시작 부작용 때문에 자동 기동하지 않습니다.', USDD_MCP_DOCS, 'mainnet'));
    checks.push(check('trongrid_mcp_tools', 'unavailable', 'TronGrid MCP 도구 목록 조회 실패', TRONGRID_MCP_DOCS, 'mainnet'));
    checks.push(check('trongrid_mcp_read', 'unknown', '공식 MCP 조회 도구 호출 미확인', TRONGRID_MCP_DOCS, 'mainnet'));
  }

  if (psm.status === 'fulfilled' && psm.value.status === 'ready') {
    const value = psm.value.value;
    const entryCapacityKnown = value.entryCapacity !== null;
    const exitCapacityKnown = value.exitCapacity !== null;
    checks.push(check('psm_entry', value.entryEnabled ? 'unknown' : 'unavailable',
      value.entryEnabled ? `USDT→USDD 활성; 진입 용량 ${value.entryCapacity ?? '미확인'} USDT; 전체 비용 미확인`
        : 'USDT→USDD 비활성', USDD_PSM_ADDRESS_SOURCE, 'mainnet'));
    checks.push(check('psm_exit', value.exitEnabled ? 'unknown' : 'unavailable',
      value.exitEnabled ? `USDD→USDT 활성; 보수적 회수 용량 ${value.exitCapacity ?? '미확인'} USDD; 전체 비용 미확인`
        : 'USDD→USDT 비활성', USDD_PSM_ADDRESS_SOURCE, 'mainnet'));
    checks.push(check('psm_jusdd_token', value.tokenCompatible === null ? 'unknown' : value.tokenCompatible ? 'ready' : 'unavailable',
      value.tokenCompatible === null ? 'PSM 실제 출력 토큰 주소 미확인' : value.tokenCompatible ? 'jUSDD 기초자산과 PSM 출력 USDD 주소 일치' : 'jUSDD 기초자산과 PSM 출력 USDD 주소 불일치', USDD_PSM_ADDRESS_SOURCE, 'mainnet'));
    checks.push(check('psm_round_trip_capacity', entryCapacityKnown && exitCapacityKnown ? 'ready' : 'unknown',
      entryCapacityKnown && exitCapacityKnown
        ? '양방향 수량 한도 조회 완료; 조회 시점 값이며 거래 가능성과 Energy/Bandwidth 비용은 별도 확인 필요'
        : '양방향 수량 한도 미확인', USDD_PSM_ADDRESS_SOURCE, 'mainnet'));
  } else {
    const reason = psm.status === 'rejected' ? 'PSM 진단 중 오류'
      : psm.value.status === 'ready' ? 'PSM 결과 불완전' : psm.value.reason;
    for (const id of ['psm_entry', 'psm_exit', 'psm_jusdd_token', 'psm_round_trip_capacity']) {
      checks.push(check(id, 'unavailable', reason, USDD_PSM_ADDRESS_SOURCE, 'mainnet'));
    }
  }

  if (nile.status === 'fulfilled' && nile.value.status === 'ready') {
    const value = nile.value.value;
    checks.push(check('nile_jtrx_code', 'ready', `Nile jTRX 후보 ${NILE_JTRX_CANDIDATE} 계약 코드 확인`, NILE_JTRX_SOURCE, 'nile'));
    checks.push(check('nile_jtrx_market', value.marketListed === null ? 'unknown' : value.marketListed ? 'ready' : 'unavailable',
      value.marketListed === null ? 'Comptroller 시장 상태 미확인' : value.marketListed ? 'Comptroller 시장 활성' : 'Comptroller 시장 비활성', NILE_RPC, 'nile'));
    checks.push(check('nile_jtrx_rate', value.exchangeRateMantissa && value.supplyRatePerBlockMantissa ? 'ready' : 'unknown',
      value.exchangeRateMantissa && value.supplyRatePerBlockMantissa ? '환율·블록당 공급 금리 읽기 성공' : '환율 또는 공급 금리 미확인', NILE_RPC, 'nile'));
    checks.push(check('nile_wallet_balance', value.walletBalanceSun !== null ? 'ready' : 'unknown',
      value.walletBalanceSun !== null ? 'Nile 공개 주소 TRX 잔고 읽기 성공' : 'Nile 공개 주소 또는 잔고 미확인', NILE_RPC, 'nile'));
    checks.push(check('nile_fee_resource', 'unknown', '선택한 예치 금액의 Energy/Bandwidth 비용과 TRX 재원 미검증', NILE_RPC, 'nile'));
  } else {
    const reason = nile.status === 'rejected' ? 'Nile jTRX 진단 중 오류'
      : nile.value.status === 'ready' ? 'Nile jTRX 결과 불완전' : nile.value.reason;
    for (const id of ['nile_jtrx_code', 'nile_jtrx_market', 'nile_jtrx_rate', 'nile_wallet_balance', 'nile_fee_resource']) {
      checks.push(check(id, 'unavailable', reason, NILE_RPC, 'nile'));
    }
  }
  if (publicWallet && !wallet) checks.push(check('nile_wallet_address_config', 'unavailable', 'Nile 공개 주소 형식 오류', NILE_RPC, 'nile'));
  if (staking.status === 'fulfilled') checks.push(check('tron_stake2', staking.value.status,
    staking.value.reasons.join('; '), staking.value.source.sourceUrl, 'mainnet'));
  else checks.push(check('tron_stake2', 'unavailable', 'Stake 2.0 진단 중 오류', `${MAINNET_RPC}/wallet/getchainparameters`, 'mainnet'));
  if (sun.status === 'fulfilled') checks.push(check('sun_stablecoin_pool', sun.value.status,
    sun.value.reasons.join('; '), sun.value.source.sourceUrl, 'mainnet'));
  else checks.push(check('sun_stablecoin_pool', 'unavailable', 'SUN.io 풀 진단 중 오류', 'https://open.sun.io/apiv2/pools', 'mainnet'));
  return checks;
}

const checks = await runDoctor();
const counts = checks.reduce((result, item) => { result[item.status]++; return result; }, { ready: 0, unavailable: 0, unknown: 0 });
console.log(JSON.stringify({ node: process.versions.node, architecture: process.arch, checks, counts }, null, 2));
if (!process.versions.node.startsWith('24.')) process.exitCode = 1;
