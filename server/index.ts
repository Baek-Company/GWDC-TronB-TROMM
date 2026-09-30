import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { ZodError } from 'zod';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { TronWeb } from 'tronweb';
import { readMarkets, readNileBlock } from './data';
import { analyzeConversation, conversationCapability } from './llm/conversation';
import { calculateLiquidity, createMainnetPlans, createNilePlans } from '../shared/planning';
import { toBaseUnits } from '../shared/markets';
import { actionPreviewSchema, dateSchema, planSchema, userNeedsSchema, type UserNeeds } from '../shared/schemas';
import { canPreviewNileDeposit } from '../shared/execution-policy';
import { readMainnetQuotes, readNileQuote } from './data/quotes';
import { readNileRedeemReference } from './data/nile-costs';
import { readNilePlanFeeScenarios } from './nile-plan-fees';
import { MAINNET_USDT_ADDRESS } from './data/usdd';
import { agentRequestStateSchema, confirmAgentRequest, toUserNeeds } from '../shared/agent-request';
import { analyzeAgentRequest, applyAgentFieldAnswer } from './agent/intake';
import { researchMarketQuestions } from './agent/research';
import { assessConfirmedNeeds } from './agent/assessment';
import { observePortfolio } from './agent/portfolio';
import { readMainnetPsmEvidence } from './data/usdd';
import { readMainnetUsdtTrxPool } from './data/swap-pool';
import { previewUsdtTrxFunding } from '../shared/swap-funding';
import { readStake2Alternative, readSunStablecoinAlternative } from './data/alternatives';
import { inspectOfficialMcp } from './mcp/registry';
import { readTronGridMcp } from './mcp/trongrid';
import { createReadGate, ReadLimitError } from './read-gate';
import { createNileDepositPreview, createNileWithdrawalPreview, NILE_CHAIN_ID, NILE_JTRX_CANDIDATE,
  probeNileWithdrawal, readNileDepositState, readNileWalletBalance, readSolidifiedNileTransaction, observeNileJtrxPosition,
  type NileDepositPreview, type NileWithdrawalPreview } from './transactions';
import { createActionLedger } from './agent/ledger';
import { createNileApprovalService } from './agent/approval-service';
import { verifyNileReferenceBlock } from './agent/nile-ref-block';
import { verifyNileApprovalPlan } from './agent/approval-plan';
import { postTronRpc } from './data/tron-rpc';
import { readNilePsmBalances } from './nile-psm';
import { createNilePsmApprovalService, createNilePsmPreview, parseNilePsmPreview } from './psm-approval';

const port = Number(process.env.API_PORT || 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid API_PORT');
const uiPort = Number(process.env.UI_PORT || 5173);
if (!Number.isInteger(uiPort) || uiPort < 1024 || uiPort > 65535) throw new Error('Invalid UI_PORT');

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function validateNeeds(needs: UserNeeds): void {
  try { calculateLiquidity(needs); }
  catch (error) {
    throw new RequestError(error instanceof Error ? error.message : '계획 조건을 확인해 주세요.', 422);
  }
}

const guardedRead = createReadGate();
const agentSessions = new Map<string, number>();
const agentSessionLifetimeMs = 30 * 60 * 1000;
function issueAgentSession(): string {
  const now = Date.now();
  for (const [key, until] of agentSessions) if (until <= now) agentSessions.delete(key);
  if (agentSessions.size >= 128) agentSessions.delete(agentSessions.keys().next().value!);
  const token = randomBytes(32).toString('hex');
  agentSessions.set(token, now + agentSessionLifetimeMs);
  return token;
}
function agentSessionValid(cookie: string | undefined): boolean {
  const token = cookie?.match(/(?:^|;\s*)gwdc_agent_session=([0-9a-f]{64})(?:;|$)/)?.[1];
  return token !== undefined && (agentSessions.get(token) ?? 0) > Date.now();
}
const approvalKey = process.env.GWDC_APPROVAL_LEDGER_KEY_HEX;
const approvalLedger = approvalKey && /^[0-9a-f]{64}$/i.test(approvalKey)
  ? createActionLedger({ path: process.env.GWDC_APPROVAL_LEDGER_PATH || 'tmp/nile-approval.sqlite',
    encryptionKey: Buffer.from(approvalKey, 'hex') }) : null;
const approvalService = approvalLedger ? createNileApprovalService({
  ledger: approvalLedger,
  verifyDepositPlan: (needs, preview) => verifyNileApprovalPlan(needs, preview, {
    readQuote: readNileQuote, readWalletBalance: readNileWalletBalance,
  }),
  verifyNileReferenceBlock: signedTransaction => verifyNileReferenceBlock(signedTransaction, {
    readNowBlock: () => postTronRpc('nile', '/wallet/getnowblock', {}),
    readBlockByNumber: number => postTronRpc('nile', '/wallet/getblockbynum', { num: number }),
  }),
  refreshPreview: preview => preview.method === 'mint()'
    ? createNileDepositPreview({ planId: preview.planId, needsVersion: preview.needsVersion,
      quoteVersion: preview.quoteVersion, address: preview.walletAddress,
      amountSun: preview.amountBaseUnits, contractAddress: preview.contractAddress })
    : createNileWithdrawalPreview({ planId: preview.planId, needsVersion: preview.needsVersion,
      quoteVersion: preview.quoteVersion, address: preview.walletAddress,
      jtrxAmountRaw: preview.amountBaseUnits, contractAddress: preview.contractAddress }),
  readTransaction: readSolidifiedNileTransaction,
  readPosition: request => observeNileJtrxPosition(request),
}) : null;
const psmApprovalService = approvalLedger ? createNilePsmApprovalService({
  ledger: approvalLedger,
  refreshPreview: preview => createNilePsmPreview({ walletAddress: preview.walletAddress,
    gemAmountRaw: preview.gemAmountRaw, step: preview.step }),
  readBalances: readNilePsmBalances,
  readTransaction: readSolidifiedNileTransaction,
  verifyNileReferenceBlock: signedTransaction => verifyNileReferenceBlock(signedTransaction, {
    readNowBlock: () => postTronRpc('nile', '/wallet/getnowblock', {}),
    readBlockByNumber: number => postTronRpc('nile', '/wallet/getblockbynum', { num: number }),
  }),
}) : null;
type NileApprovalPreview = NileDepositPreview | NileWithdrawalPreview;
const approvalPreviewSchema = actionPreviewSchema.extend({
  chain: z.literal('nile'), method: z.enum(['mint()', 'redeem(uint256)']),
  state: z.record(z.string(), z.unknown()),
  feeLimitSun: z.string().regex(/^\d+$/), expectedUnderlyingSun: z.string().regex(/^\d+$/).optional(),
}).passthrough();
function approvalPreview(value: unknown): NileApprovalPreview {
  return approvalPreviewSchema.parse(value) as unknown as NileApprovalPreview;
}
const executionCapabilities = {
  mainnetExecution: false,
  nileExperimentalExecution: true, // API preview path exists; this is not a claim of transaction success.
  nileWalletReady: null, // TronLink availability and account are known only in the client.
  nileChainReady: null, // Readiness must be checked for each wallet action.
  nileApprovalLedgerReady: approvalService !== null,
  executionEnabled: false, // Legacy field: Mainnet execution is disabled.
};

async function readJson(req: import('node:http').IncomingMessage, limit = 8192): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new RequestError('JSON 요청만 허용합니다.', 415);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new RequestError('요청 크기가 제한을 초과했습니다.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new RequestError('JSON 형식을 확인해 주세요.', 400); }
}

function localOrigin(origin: string | undefined) {
  if (!origin) return true;
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`,
    `http://127.0.0.1:${uiPort}`, `http://localhost:${uiPort}`].includes(origin);
}

function approvalOrigin(origin: string | undefined): string {
  if (!origin || !localOrigin(origin)) throw new RequestError('Nile 승인 요청에는 로컬 화면 출처가 필요합니다.', 403);
  return origin;
}

function readyApprovalService(): NonNullable<typeof approvalService> {
  if (!approvalService) throw new RequestError('Nile 승인 원장 키가 미설정입니다. 거래를 시작할 수 없습니다.', 503);
  return approvalService;
}

function readyPsmApprovalService(): NonNullable<typeof psmApprovalService> {
  if (!psmApprovalService) throw new RequestError('Nile PSM 승인 원장 키가 미설정입니다. 거래를 시작할 수 없습니다.', 503);
  return psmApprovalService;
}

function approvalAccount(cookie: string | undefined, origin?: string): string {
  try { return readyApprovalService().accountFor(cookie, origin); }
  catch { throw new RequestError('Nile 지갑 인증이 없거나 만료되었습니다. 다시 서명해 주세요.', 401); }
}

async function approvalOperation<T>(run: () => T | Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof ZodError || error instanceof RequestError) throw error;
    if (error && typeof error === 'object' && 'code' in error) {
      throw new RequestError('Nile 원장 또는 RPC를 확인할 수 없어 거래를 중단했습니다.', 503);
    }
    throw new RequestError(error instanceof Error ? error.message : 'Nile 승인 상태를 확인할 수 없습니다.', 409);
  }
}

const server = createServer(async (req, res) => {
  let path = '/';
  const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    if (res.destroyed || res.headersSent) return;
    try {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', ...(status === 429 ? { 'Retry-After': '5' } : {}), ...headers });
      res.end(JSON.stringify(body));
    } catch { res.destroy(); }
  };
  try {
    let url: URL;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { throw new RequestError('요청 경로를 확인해 주세요.', 400); }
    path = url.pathname;
    if (req.method === 'GET' && req.headers['sec-fetch-site'] === 'cross-site') {
      throw new RequestError('다른 사이트의 로컬 API 조회는 허용되지 않습니다.', 403);
    }
    if (req.method === 'POST' && req.headers['sec-fetch-site'] === 'cross-site') {
      throw new RequestError('다른 사이트의 로컬 API 요청은 허용되지 않습니다.', 403);
    }
    if (req.method === 'POST' && !localOrigin(req.headers.origin)) throw new RequestError('이 출처의 요청은 허용되지 않습니다.', 403);
    if (req.method === 'POST' && path === '/api/approval/challenge') {
      const service = readyApprovalService();
      const origin = approvalOrigin(req.headers.origin);
      const { address } = z.object({ address: z.string().min(1).max(64) }).parse(await readJson(req));
      send(200, await approvalOperation(() => service.challenge(address, origin)));
    } else if (req.method === 'POST' && path === '/api/approval/authenticate') {
      const service = readyApprovalService();
      const origin = approvalOrigin(req.headers.origin);
      const body = z.object({ challengeId: z.string().regex(/^[0-9a-f]{64}$/),
        address: z.string().min(1).max(64), signature: z.string().min(1).max(200) }).parse(await readJson(req));
      const authenticated = await approvalOperation(() => service.authenticate(body, origin));
      send(200, { account: authenticated.account, expiresAt: authenticated.expiresAt },
        { 'Set-Cookie': `gwdc_nile_approval=${authenticated.token}; HttpOnly; SameSite=Strict; Path=/api/approval; Max-Age=600` });
    } else if (req.method === 'POST' && path === '/api/approval/reserve') {
      const service = readyApprovalService();
      const account = approvalAccount(req.headers.cookie, approvalOrigin(req.headers.origin));
      const body = z.object({ preview: z.unknown(), confirmedPreviewId: z.string().min(1).max(100),
        needs: userNeedsSchema.optional(), depositIntentId: z.string().regex(/^[0-9a-f]{64}$/).optional() })
        .parse(await readJson(req, 65536));
      send(200, { intent: await approvalOperation(() => service.reserve(account,
        approvalPreview(body.preview), body.confirmedPreviewId, body.needs, body.depositIntentId)) });
    } else if (req.method === 'POST' && path === '/api/approval/signed') {
      const service = readyApprovalService();
      const account = approvalAccount(req.headers.cookie, approvalOrigin(req.headers.origin));
      const body = z.object({ intentId: z.string().regex(/^[0-9a-f]{64}$/),
        preview: z.unknown(), signedTransaction: z.record(z.string(), z.unknown()) })
        .parse(await readJson(req, 65536));
      send(200, { intent: await approvalOperation(() => service.acceptSigned(account, {
        intentId: body.intentId, preview: approvalPreview(body.preview), signedTransaction: body.signedTransaction,
      })) });
    } else if (req.method === 'POST' && path === '/api/approval/begin-broadcast') {
      const service = readyApprovalService();
      const account = approvalAccount(req.headers.cookie, approvalOrigin(req.headers.origin));
      const body = z.object({ intentId: z.string().regex(/^[0-9a-f]{64}$/), preview: z.unknown() })
        .parse(await readJson(req, 65536));
      send(200, await approvalOperation(() => service.beginBroadcast(account, {
        intentId: body.intentId, preview: approvalPreview(body.preview),
      })));
    } else if (req.method === 'POST' && path === '/api/approval/broadcast-result') {
      const service = readyApprovalService();
      const account = approvalAccount(req.headers.cookie, approvalOrigin(req.headers.origin));
      const body = z.object({ intentId: z.string().regex(/^[0-9a-f]{64}$/), accepted: z.boolean().nullable() })
        .parse(await readJson(req));
      send(200, { intent: await approvalOperation(() => service.recordBroadcastResult(account, body.intentId, body.accepted)) });
    } else if (req.method === 'POST' && path === '/api/approval/reconcile') {
      const service = readyApprovalService();
      const account = approvalAccount(req.headers.cookie, approvalOrigin(req.headers.origin));
      const { intentId } = z.object({ intentId: z.string().regex(/^[0-9a-f]{64}$/) }).parse(await readJson(req));
      send(200, await approvalOperation(() => service.reconcile(account, intentId)));
    } else if (req.method === 'POST' && path === '/api/approval/cancel') {
      const service = readyApprovalService();
      const account = approvalAccount(req.headers.cookie, approvalOrigin(req.headers.origin));
      const { intentId } = z.object({ intentId: z.string().regex(/^[0-9a-f]{64}$/) }).parse(await readJson(req));
      send(200, { intent: await approvalOperation(() => service.cancel(account, intentId)) });
    } else if (req.method === 'GET' && path === '/api/approval/unresolved') {
      const service = readyApprovalService();
      const account = approvalAccount(req.headers.cookie);
      send(200, { intents: service.unresolved(account).filter(intent =>
        /^nile:justlend_jtrx:(?:80_20|50_50):v2:[0-9a-f]{64}$/.test(intent.planId)) });
    } else if (req.method === 'POST' && path === '/api/approval/psm/reserve') {
      const service = readyPsmApprovalService();
      const account = approvalAccount(req.headers.cookie, approvalOrigin(req.headers.origin));
      const body = z.object({ preview: z.unknown(), confirmedPreviewId: z.string().min(1).max(100) })
        .parse(await readJson(req, 65536));
      send(200, { intent: await approvalOperation(() => service.reserve(account,
        parseNilePsmPreview(body.preview), body.confirmedPreviewId)) });
    } else if (req.method === 'POST' && path === '/api/approval/psm/signed') {
      const service = readyPsmApprovalService();
      const account = approvalAccount(req.headers.cookie, approvalOrigin(req.headers.origin));
      const body = z.object({ intentId: z.string().regex(/^[0-9a-f]{64}$/), preview: z.unknown(),
        signedTransaction: z.record(z.string(), z.unknown()) }).parse(await readJson(req, 65536));
      send(200, { intent: await approvalOperation(() => service.acceptSigned(account, {
        intentId: body.intentId, preview: parseNilePsmPreview(body.preview), signedTransaction: body.signedTransaction,
      })) });
    } else if (req.method === 'POST' && path === '/api/approval/psm/begin-broadcast') {
      const service = readyPsmApprovalService();
      const account = approvalAccount(req.headers.cookie, approvalOrigin(req.headers.origin));
      const body = z.object({ intentId: z.string().regex(/^[0-9a-f]{64}$/), preview: z.unknown() })
        .parse(await readJson(req, 65536));
      send(200, await approvalOperation(() => service.beginBroadcast(account, {
        intentId: body.intentId, preview: parseNilePsmPreview(body.preview),
      })));
    } else if (req.method === 'POST' && path === '/api/approval/psm/broadcast-result') {
      const service = readyPsmApprovalService();
      const account = approvalAccount(req.headers.cookie, approvalOrigin(req.headers.origin));
      const body = z.object({ intentId: z.string().regex(/^[0-9a-f]{64}$/), accepted: z.boolean().nullable() })
        .parse(await readJson(req));
      send(200, { intent: await approvalOperation(() => service.recordBroadcastResult(account, body.intentId, body.accepted)) });
    } else if (req.method === 'POST' && path === '/api/approval/psm/reconcile') {
      const service = readyPsmApprovalService();
      const account = approvalAccount(req.headers.cookie, approvalOrigin(req.headers.origin));
      const { intentId } = z.object({ intentId: z.string().regex(/^[0-9a-f]{64}$/) }).parse(await readJson(req));
      send(200, await approvalOperation(() => service.reconcile(account, intentId)));
    } else if (req.method === 'POST' && path === '/api/approval/psm/cancel') {
      const service = readyPsmApprovalService();
      const account = approvalAccount(req.headers.cookie, approvalOrigin(req.headers.origin));
      const { intentId } = z.object({ intentId: z.string().regex(/^[0-9a-f]{64}$/) }).parse(await readJson(req));
      send(200, { intent: await approvalOperation(() => service.cancel(account, intentId)) });
    } else if (req.method === 'GET' && path === '/api/approval/psm/unresolved') {
      const service = readyPsmApprovalService();
      const account = approvalAccount(req.headers.cookie);
      send(200, { intents: service.unresolved(account) });
    } else if (req.method === 'GET' && path === '/api/agent/session') {
      const token = issueAgentSession();
      send(200, { ready: true }, { 'Set-Cookie': `gwdc_agent_session=${token}; HttpOnly; SameSite=Strict; Path=/api/agent; Max-Age=1800` });
    } else if (path.startsWith('/api/agent/') && !agentSessionValid(req.headers.cookie)) {
      throw new RequestError('에이전트 세션이 만료되었습니다. 화면을 새로고침해 주세요.', 401);
    } else if (req.method === 'POST' && path === '/api/agent/intake') {
      const input = z.object({ message: z.string().trim().min(1).max(2000),
        current: agentRequestStateSchema.optional(), messageId: z.string().max(100).optional() })
        .parse(await readJson(req, 65536));
      send(200, await analyzeAgentRequest({ ...input, utteredAt: new Date().toISOString() }));
    } else if (req.method === 'POST' && path === '/api/agent/field') {
      const input = z.object({ current: agentRequestStateSchema,
        field: z.string().min(1).max(80), value: z.string().trim().min(1).max(120) })
        .parse(await readJson(req, 65536));
      send(200, applyAgentFieldAnswer({ ...input, utteredAt: new Date().toISOString() }));
    } else if (req.method === 'POST' && path === '/api/agent/confirm') {
      const { request } = z.object({ request: agentRequestStateSchema }).parse(await readJson(req, 65536));
      try { send(200, { request: confirmAgentRequest(request) }); }
      catch { throw new RequestError('누락되거나 충돌하는 계획 조건을 먼저 확인해 주세요.', 422); }
    } else if (req.method === 'POST' && path === '/api/agent/research') {
      const { questions } = z.object({ questions: z.array(z.string().trim().min(1).max(500)).min(1).max(5) })
        .parse(await readJson(req, 65536));
      send(200, await guardedRead(JSON.stringify(['agent-research', questions]), 5_000,
        () => researchMarketQuestions(questions)));
    } else if (req.method === 'POST' && path === '/api/agent/portfolio') {
      const input = z.object({ chain: z.enum(['mainnet', 'nile']), address: z.string().min(1).max(64),
        declaredHoldings: z.object({ asset: z.string().min(1).max(16),
          amount: z.string().regex(/^\d+(?:\.\d+)?$/).max(80) }).nullable().optional() })
        .parse(await readJson(req, 65536));
      if (!TronWeb.isAddress(input.address)) throw new RequestError('유효한 TRON 지갑 주소가 필요합니다.', 422);
      send(200, await guardedRead(JSON.stringify(['agent-portfolio', input]), 5_000,
        () => observePortfolio(input)));
    } else if (req.method === 'POST' && path === '/api/agent/assessment') {
      const { request, address, asOfDate } = z.object({ request: agentRequestStateSchema,
        address: z.string().min(1).max(64).optional(),
        asOfDate: dateSchema.optional() }).parse(await readJson(req, 65536));
      if (address && !TronWeb.isAddress(address)) throw new RequestError('유효한 TRON 지갑 주소가 필요합니다.', 422);
      const observedToken = request.explicitFacts.asset === 'USDT'
        ? { symbol: 'USDT', address: MAINNET_USDT_ADDRESS, decimals: 6 } : undefined;
      let needs: UserNeeds;
      try { needs = toUserNeeds(request, observedToken); }
      catch { throw new RequestError('확인된 요청 JSON과 자산·날짜·금액 조건을 다시 확인해 주세요.', 422); }
      if ((needs.chain === 'mainnet' && needs.asset.symbol !== 'USDT')
        || (needs.chain === 'nile' && needs.asset.symbol !== 'TRX')) {
        throw new RequestError('현재 평가는 Mainnet USDT 또는 Nile TRX만 지원합니다.', 422);
      }
      if (asOfDate !== undefined) {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(new Date());
        const part = (type: string) => parts.find(item => item.type === type)?.value;
        const today = `${part('year')}-${part('month')}-${part('day')}`;
        if (asOfDate !== today || asOfDate >= needs.endDate) {
          throw new RequestError('남은 기간 재평가 날짜는 오늘이며 계획 종료일 전이어야 합니다.', 422);
        }
        if (asOfDate > needs.startDate && needs.expenses.some(expense => expense.date <= asOfDate)) {
          throw new RequestError('이미 도래한 지출의 실제 지급 여부를 먼저 확인해 주세요.', 422);
        }
      }
      send(200, await guardedRead(JSON.stringify(['agent-assessment', request.version, request.explicitFacts, address, asOfDate]), 5_000,
        () => assessConfirmedNeeds(needs, address, asOfDate)));
    } else if (req.method === 'POST' && path === '/api/chat') {
      send(200, await analyzeConversation(await readJson(req)));
    } else if (req.method === 'POST' && path === '/api/plans') {
      const { needs } = z.object({ needs: userNeedsSchema }).parse(await readJson(req, 65536));
      if (needs.chain !== 'mainnet' || needs.asset.symbol !== 'USDT' || needs.asset.decimals !== 6
        || (needs.asset.address !== null && needs.asset.address !== MAINNET_USDT_ADDRESS)) {
        throw new RequestError('Mainnet USDT 조건이 필요합니다.', 400);
      }
      validateNeeds(needs);
      send(200, await guardedRead(JSON.stringify(['manual-plans', needs]), 5_000, async () => {
        const data = await readMainnetQuotes();
        // The form may have no REST snapshot yet. Read-only comparison uses the
        // official candidate; each product still verifies this address on chain.
        const comparedNeeds = needs.asset.address === null ? { ...needs,
          asset: { ...needs.asset, address: MAINNET_USDT_ADDRESS },
          expenses: needs.expenses.map(expense => ({ ...expense,
            asset: { ...expense.asset, address: MAINNET_USDT_ADDRESS } })) } : needs;
        const result = createMainnetPlans(comparedNeeds, data);
        return { ...result, basis: 'declared_hypothetical' as const, walletSized: false as const,
          diagnostics: data.diagnostics.map(item => ({ name: item.checkId, status: item.status, reason: item.reason })) };
      }));
    } else if (req.method === 'POST' && path === '/api/funding') {
      const { needs } = z.object({ needs: userNeedsSchema }).parse(await readJson(req, 65536));
      if (needs.chain !== 'mainnet' || needs.asset.symbol !== 'USDT' || needs.asset.decimals !== 6
        || (needs.asset.address !== null && needs.asset.address !== MAINNET_USDT_ADDRESS)) {
        throw new RequestError('Mainnet USDT 조건이 필요합니다.', 400);
      }
      validateNeeds(needs);
      const liquidity = calculateLiquidity(needs);
      send(200, await guardedRead(JSON.stringify(['funding-illustration', needs]), 10_000, async () => {
        const [pool, stake] = await Promise.all([readMainnetUsdtTrxPool(), readStake2Alternative()]);
        let preview: ReturnType<typeof previewUsdtTrxFunding> | null = null;
        let reason: string | null = null;
        if (pool.status === 'ready' && new Decimal(liquidity.investableAmount).gt(0)) {
          try { preview = previewUsdtTrxFunding(liquidity.investableAmount, pool.value); }
          catch (error) { reason = error instanceof Error ? error.message : '교환 예시를 계산할 수 없습니다.'; }
        }
        return { protectedUsdt: liquidity.protectedAmount, candidateUsdt: liquidity.investableAmount,
          pool, stake, preview, reason, basis: 'reserve_snapshot_illustration' as const,
          executionReady: false as const };
      }));
    } else if (req.method === 'POST' && path === '/api/nile/plans') {
      const { needs, address } = z.object({ needs: userNeedsSchema, address: z.string().min(1) }).parse(await readJson(req));
      if (needs.chain !== 'nile' || needs.asset.symbol !== 'TRX') throw new RequestError('Nile TRX 조건이 필요합니다.', 400);
      validateNeeds(needs);
      const data = await readNileQuote(address);
      const diagnostics = data.diagnostics.map(item => ({ name: item.checkId, status: item.status, reason: item.reason }));
      if (!data.jTrx) {
        send(200, { plans: [], recommendedPlanId: null, nileFeeScenarios: [], diagnostics });
      } else {
        let walletBalance: string | null = null;
        try { walletBalance = new Decimal((await readNileWalletBalance(address)).balanceSun).div('1000000').toString(); }
        catch { /* wallet status remains unverified */ }
        const result = createNilePlans(needs, data.jTrx, { walletBalance });
        const nileFeeScenarios = await readNilePlanFeeScenarios(needs, result.plans, address,
          data.exchangeRateRaw ?? null, { readDepositState: readNileDepositState,
            readRedeemReference: readNileRedeemReference });
        send(200, { ...result, diagnostics, nileRatePerBlockRaw: data.ratePerBlockRaw ?? null,
          nileFeeScenarios });
      }
    } else if (req.method === 'POST' && path === '/api/preview') {
      const { needs, planId, address } = z.object({ needs: userNeedsSchema, planId: z.string().min(1), address: z.string().min(1) }).parse(await readJson(req));
      if (needs.chain !== 'nile' || needs.asset.symbol !== 'TRX' || needs.confirmedVersion !== needs.inputVersion) {
        throw new RequestError('확인된 Nile TRX 계획이 필요합니다.', 409);
      }
      validateNeeds(needs);
      const data = await readNileQuote(address);
      if (!data.jTrx) throw new RequestError('Nile jTRX 견적이 없습니다. 시장·계약 연결을 확인해 주세요.', 409);
      const balance = await readNileWalletBalance(address);
      const walletBalance = new Decimal(balance.balanceSun).div('1000000').toString();
      const plans = createNilePlans(needs, data.jTrx, { walletBalance });
      const plan = plans.plans.find(item => item.id === planId);
      if (!plan || !canPreviewNileDeposit(plan) || !plan.quoteVersion) {
        throw new RequestError('선택 계획이 최신 검증을 통과하지 못했습니다. 계획을 다시 확인해 주세요.', 409);
      }
      const preview = await createNileDepositPreview({ planId: plan.id, needsVersion: needs.inputVersion,
        quoteVersion: plan.quoteVersion, address, amountSun: toBaseUnits(plan.allocation.invested, 6) });
      preview.risks.push('Nile 기술 시험: 연환산 금리와 출금 왕복 비용이 미확인이라 수익 권고가 아닙니다.');
      send(200, preview);
    } else if (req.method === 'POST' && path === '/api/withdraw/preview') {
      const { plan, address, jtrxAmountRaw } = z.object({ plan: planSchema, address: z.string().min(1),
        jtrxAmountRaw: z.string().regex(/^[1-9]\d*$/) }).parse(await readJson(req));
      if (plan.chain !== 'nile' || plan.kind !== 'justlend_jtrx'
        || !/^nile:justlend_jtrx:(80_20|50_50):v2:[0-9a-f]{64}$/.test(plan.id) ||
        !plan.quote || !plan.quoteVersion || plan.quoteVersion !== plan.quote.quoteVersion ||
        plan.quote.marketAddress !== NILE_JTRX_CANDIDATE) {
        throw new RequestError('같은 Nile jTRX 원 계획과 계약이 필요합니다.', 409);
      }
      const probe = await probeNileWithdrawal({ address, jtrxAmountRaw, contractAddress: plan.quote.marketAddress });
      if (probe.status === 'deferred') send(200, probe);
      else send(200, { status: 'ready', preview: await createNileWithdrawalPreview({
        planId: plan.id, needsVersion: plan.needsVersion, quoteVersion: plan.quoteVersion,
        address, jtrxAmountRaw, contractAddress: plan.quote.marketAddress,
      }) });
    } else if (req.method === 'POST' && path === '/api/nile/psm/preview') {
      const input = z.object({ address: z.string().min(1).max(64),
        step: z.enum(['approve_usdd', 'buy_gem', 'approve_usdt', 'sell_gem']),
        gemAmountRaw: z.string().regex(/^[1-9]\d*$/).max(78) }).parse(await readJson(req));
      if (!TronWeb.isAddress(input.address)) throw new RequestError('유효한 Nile 지갑 주소가 필요합니다.', 422);
      send(200, await approvalOperation(() => createNilePsmPreview({ walletAddress: input.address,
        step: input.step, gemAmountRaw: input.gemAmountRaw })));
    } else if (req.method === 'GET' && path === '/api/nile/psm/balance') {
      const address = url.searchParams.get('address');
      if (!address || !TronWeb.isAddress(address)) throw new RequestError('유효한 Nile 지갑 주소가 필요합니다.', 422);
      send(200, await guardedRead(JSON.stringify(['nile-psm-balance', address]), 2_000,
        () => readNilePsmBalances(address)));
    } else if (req.method === 'GET' && path === '/api/health') {
      send(200, { ok: true, node: process.versions.node, stage: 'development', ...executionCapabilities });
    } else if (req.method === 'GET' && path === '/api/capabilities') {
      send(200, { ai: conversationCapability(), ...executionCapabilities });
    } else if (req.method === 'GET' && path === '/api/sources') {
      const sources = await guardedRead('sources', 15_000, async () => {
        const [psm, stake, sun, mcp, trongridRead] = await Promise.all([
        readMainnetPsmEvidence(), readStake2Alternative(), readSunStablecoinAlternative(), inspectOfficialMcp(),
        readTronGridMcp('getEventsByLatestBlock', {}),
        ]);
        return { psm, stake, sun, mcp,
          trongridRead: trongridRead.status === 'ready' && !trongridRead.value.outputSchemaVerified
            ? { status: 'unknown', reason: '공식 MCP 읽기 호출은 성공했지만 결과 필드·단위는 아직 검증하지 않았습니다.', source: trongridRead.source }
            : trongridRead };
      });
      send(200, sources);
    } else if (req.method === 'GET' && /^\/api\/transactions\/[0-9a-fA-F]{64}$/.test(path)) {
      send(200, await guardedRead(path.toLowerCase(), 3_000,
        () => readSolidifiedNileTransaction(path.slice('/api/transactions/'.length))));
    } else if (req.method === 'GET' && path === '/api/observe') {
      const planId = url.searchParams.get('planId');
      const address = url.searchParams.get('address');
      if (!planId || !address) throw new RequestError('계획 ID와 Nile 지갑 주소가 필요합니다.', 400);
      send(200, await guardedRead(JSON.stringify(['observe', planId, address]), 5_000,
        () => observeNileJtrxPosition({ planId, address })));
    } else if (req.method === 'GET' && path === '/api/markets') send(200, await guardedRead('markets', 10_000, () => readMarkets()));
    else if (req.method === 'GET' && path === '/api/nile') send(200, await guardedRead('nile', 2_000, () => readNileBlock()));
    else if (['GET', 'POST'].includes(req.method || '') && ['/api/approval/challenge', '/api/approval/authenticate',
      '/api/approval/reserve', '/api/approval/signed', '/api/approval/begin-broadcast', '/api/approval/broadcast-result',
      '/api/approval/reconcile', '/api/approval/cancel', '/api/approval/unresolved',
      '/api/approval/psm/reserve', '/api/approval/psm/signed', '/api/approval/psm/begin-broadcast',
      '/api/approval/psm/broadcast-result', '/api/approval/psm/reconcile', '/api/approval/psm/cancel',
      '/api/approval/psm/unresolved',
      '/api/agent/session', '/api/agent/intake', '/api/agent/field', '/api/agent/confirm',
      '/api/agent/research', '/api/agent/portfolio', '/api/agent/assessment', '/api/chat', '/api/plans', '/api/funding', '/api/nile/plans', '/api/preview',
      '/api/withdraw/preview', '/api/nile/psm/preview', '/api/nile/psm/balance',
      '/api/health', '/api/capabilities', '/api/sources', '/api/markets', '/api/nile', '/api/observe'].includes(path)) {
      send(405, { error: 'Method not allowed' });
    } else send(404, { error: 'Not found' });
  } catch (error) {
    if (error instanceof RequestError || error instanceof ReadLimitError) { send(error.status, { error: error.message }); return; }
    if (error instanceof ZodError) { send(400, { error: '요청 필드를 확인해 주세요.', issues: error.issues.map(issue => issue.path.join('.')) }); return; }
    console.error(`[${path}] ${error instanceof Error ? error.name : 'Error'}`);
    send(502, { error: '외부 데이터 또는 Nile RPC 조회에 실패했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요. 샘플을 라이브 데이터로 대체하지 않습니다.' });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`GWDC read API: http://127.0.0.1:${port}`));
server.on('error', error => { console.error(error.message); process.exit(1); });
process.on('SIGTERM', () => server.close(() => approvalLedger?.close()));
