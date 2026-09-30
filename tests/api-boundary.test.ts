import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNilePlans } from '../shared/planning';
import { productQuoteSchema, userNeedsSchema } from '../shared/schemas';
import { MAINNET_USDT_ADDRESS } from '../server/data/usdd';

let child: ChildProcess;
let port: number;

async function unusedPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const assigned = (socket.address() as AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return assigned;
}

beforeAll(async () => {
  port = await unusedPort();
  child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(), stdio: 'ignore',
    // This subprocess tests local boundaries only and does not inherit provider credentials.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, API_PORT: String(port), UI_PORT: '5173' },
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Test API did not start');
}, 10_000);

afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>(resolve => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2_000).unref();
  });
});

function needs(chain: 'mainnet' | 'nile', endDate: string, reserve = '0') {
  const asset = chain === 'mainnet' ? { symbol: 'USDT', address: MAINNET_USDT_ADDRESS, decimals: 6 }
    : { symbol: 'TRX', address: null, decimals: 6 };
  return { chain, asset, amount: '1000', startDate: '2026-09-29', endDate,
    expenses: [{ date: '2026-10-06', amount: '900', asset }], liquidReserve: reserve,
    riskPreference: 'balanced', acceptsUsddRisk: false, timezone: 'Asia/Seoul',
    inputVersion: 1, confirmedVersion: 1 };
}

async function rawRequest(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const connection = createConnection({ host: '127.0.0.1', port }, () => {
      connection.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let body = '';
    connection.on('data', chunk => { body += chunk.toString(); });
    connection.on('end', () => resolve(body));
    connection.on('error', reject);
  });
}

describe('local API request boundaries', () => {
  it('requires a local agent session and keeps invalid direct answers from advancing the request', async () => {
    const endpoint = `http://127.0.0.1:${port}`;
    const denied = await fetch(`${endpoint}/api/agent/intake`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '자산 계획' }) });
    expect(denied.status).toBe(401);
    const session = await fetch(`${endpoint}/api/agent/session`);
    expect(session.status).toBe(200);
    const cookie = session.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toMatch(/^gwdc_agent_session=/);
    const headers = { 'Content-Type': 'application/json', Cookie: cookie! };
    const intake = await fetch(`${endpoint}/api/agent/intake`, { method: 'POST', headers,
      body: JSON.stringify({ message: '오늘부터 자산 계획을 세우고 싶어요',
        utteredAt: '2000-01-01T00:00:00.000Z' }) });
    expect(intake.status).toBe(200);
    const first = await intake.json() as { request: { evidence: { path: string; utteredAt: string }[] }; nextQuestion: { field: string } };
    expect(first.nextQuestion.field).toBe('chain');
    expect(first.request.evidence.find(item => item.path === 'explicitFacts.startDate')?.utteredAt)
      .not.toBe('2000-01-01T00:00:00.000Z');
    const invalid = await fetch(`${endpoint}/api/agent/field`, { method: 'POST', headers,
      body: JSON.stringify({ current: first.request, field: 'chain', value: 'unknown-chain' }) });
    expect(invalid.status).toBe(200);
    const invalidResult = await invalid.json() as { request: unknown; fieldError: string };
    expect(invalidResult.fieldError).toBeTruthy();
    expect(invalidResult.request).toEqual(first.request);
    const valid = await fetch(`${endpoint}/api/agent/field`, { method: 'POST', headers,
      body: JSON.stringify({ current: first.request, field: 'chain', value: 'mainnet' }) });
    expect(valid.status).toBe(200);
    expect((await valid.json() as { request: { explicitFacts: { chain: string } } }).request.explicitFacts.chain).toBe('mainnet');
    const premature = await fetch(`${endpoint}/api/agent/confirm`, { method: 'POST', headers,
      body: JSON.stringify({ request: first.request }) });
    expect(premature.status).toBe(422);
    const invalidPortfolio = await fetch(`${endpoint}/api/agent/portfolio`, { method: 'POST', headers,
      body: JSON.stringify({ chain: 'nile', address: 'not-a-tron-address' }) });
    expect(invalidPortfolio.status).toBe(422);
  });

  it('classifies invalid Mainnet and Nile plan conditions before external reads', async () => {
    const cases = [
      ['/api/plans', { needs: needs('mainnet', '2036-09-29') }],
      ['/api/plans', { needs: needs('mainnet', '2026-10-29', '200') }],
      ['/api/nile/plans', { needs: needs('nile', '2026-10-29', '200'), address: 'TNILE' }],
    ] as const;
    for (const [path, body] of cases) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(422);
      expect((await response.json() as { error: string }).error).toBeTruthy();
    }
  });

  it('keeps serving after an invalid request target', async () => {
    const raw = await rawRequest('//%5B');
    expect(raw).toMatch(/^HTTP\/1\.1 400 /);
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(response.status).toBe(200);
  });

  it('rejects cross-site GET and describes Mainnet/Nile readiness separately', async () => {
    const denied = await fetch(`http://127.0.0.1:${port}/api/sources`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(denied.status).toBe(403);
    const response = await fetch(`http://127.0.0.1:${port}/api/capabilities`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mainnetExecution: false, nileExperimentalExecution: true,
      nileWalletReady: null, nileChainReady: null });
  });

  it('does not start a new withdrawal preview from a legacy Nile plan ID', async () => {
    const source = { sourceUrl: 'https://nile.trongrid.io', chain: 'nile' as const,
      fetchedAt: new Date().toISOString(), sourceUpdatedAt: null, mode: 'live' as const, accessMethod: 'rpc' as const };
    const trx = { symbol: 'TRX', address: null, decimals: 6 };
    const quote = productQuoteSchema.parse({ id: 'nile-jtrx', quoteVersion: 'q1', product: 'justlend_jtrx', chain: 'nile',
      marketAddress: 'TKM7w4qFmkXQLEF2MgrQroBYpd5TY7i1pq', inputToken: trx, depositToken: trx,
      receiptToken: { symbol: 'jTRX', address: 'TKM7w4qFmkXQLEF2MgrQroBYpd5TY7i1pq', decimals: 8 },
      baseRate: null, reward: null, liquidity: { exitAvailable: '100000', withdrawalDelayDays: 0 },
      conversion: null, costs: [], status: 'active', risks: [], source });
    const plan = createNilePlans(userNeedsSchema.parse(needs('nile', '2026-10-29')), quote).plans[1];
    const response = await fetch(`http://127.0.0.1:${port}/api/withdraw/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: { ...plan, id: 'nile:justlend_jtrx:80_20:legacy' },
        address: 'TNILE', jtrxAmountRaw: '1' }),
    });
    expect(response.status).toBe(409);
  });
});
