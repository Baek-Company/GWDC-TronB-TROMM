import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Trx, TronWeb } from 'tronweb';
import type { NileDepositPreview } from '../server/transactions';

const origin = 'http://127.0.0.1:5173';
const fixture = join(process.cwd(), 'tests/fixtures/nile-http-rpc.mjs');
const dayMs = 86_400_000;
let child: ChildProcess;
let directory: string;
let ledgerPath: string;
let controlPath: string;
let logPath: string;
let port: number;

function seoulDay(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function plusDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * dayMs).toISOString().slice(0, 10);
}

function needs() {
  const startDate = seoulDay();
  return {
    chain: 'nile' as const, asset: { symbol: 'TRX', address: null, decimals: 6 },
    amount: '100', startDate, endDate: plusDays(startDate, 30),
    expenses: [{ date: plusDays(startDate, 7), amount: '10',
      asset: { symbol: 'TRX', address: null, decimals: 6 } }],
    liquidReserve: '0', riskPreference: 'balanced' as const, acceptsUsddRisk: false,
    timezone: 'Asia/Seoul' as const, inputVersion: 1, confirmedVersion: 1,
  };
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const result = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return result;
}

function control(config: Record<string, unknown> = {}): void {
  writeFileSync(controlPath, JSON.stringify(config));
}

function rpcCalls() {
  const content = readFileSync(logPath, 'utf8').trim();
  return content ? content.split('\n').map(line => JSON.parse(line) as {
    path: string; selector: string; method: string; fault: string | null;
  }) : [];
}

async function post(path: string, body: unknown, cookie?: string) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
  });
}

async function previewFor(address: string, confirmedNeeds: ReturnType<typeof needs>): Promise<NileDepositPreview> {
  const planned = await post('/api/nile/plans', { address, needs: confirmedNeeds });
  expect(planned.status).toBe(200);
  const planSet = await planned.json() as { plans: Array<{ id: string; kind: string; scenario: string }>;
    nileRatePerBlockRaw: string | null };
  expect(planSet.nileRatePerBlockRaw).toBe('100');
  const selected = planSet.plans.find(plan => plan.kind === 'justlend_jtrx' && plan.scenario === '80_20');
  expect(selected).toBeDefined();
  const response = await post('/api/preview', { address, needs: confirmedNeeds, planId: selected!.id });
  if (response.status !== 200) throw new Error(`Preview response ${response.status}: ${await response.text()}`);
  const preview = await response.json() as NileDepositPreview;
  expect(preview).toMatchObject({ walletAddress: address, method: 'mint()', chain: 'nile' });
  return preview;
}

async function authenticate(address: string, privateKey: string): Promise<string> {
  const challengeResponse = await post('/api/approval/challenge', { address });
  expect(challengeResponse.status).toBe(200);
  const challenge = await challengeResponse.json() as { challengeId: string; message: string };
  const authenticated = await post('/api/approval/authenticate', {
    challengeId: challenge.challengeId, address,
    signature: Trx.signMessageV2(challenge.message, privateKey),
  });
  expect(authenticated.status).toBe(200);
  const cookie = authenticated.headers.get('set-cookie')?.split(';')[0];
  expect(cookie).toMatch(/^gwdc_nile_approval=[0-9a-f]{64}$/);
  return cookie!;
}

async function assertNoIntentOrPayload(cookie: string, preview: NileDepositPreview,
  rpcOffset: number): Promise<void> {
  const unresolved = await fetch(`http://127.0.0.1:${port}/api/approval/unresolved`, {
    headers: { Cookie: cookie },
  });
  expect(unresolved.status).toBe(200);
  expect(await unresolved.json()).toEqual({ intents: [] });
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM action_intents').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM action_intent_events').get()).toMatchObject({ n: 0 });
  } finally { db.close(); }

  const absentId = 'a'.repeat(64);
  expect((await post('/api/approval/signed', {
    intentId: absentId, preview, signedTransaction: {},
  }, cookie)).status).not.toBe(200);
  expect((await post('/api/approval/begin-broadcast', {
    intentId: absentId, preview,
  }, cookie)).status).not.toBe(200);
  expect(rpcCalls().slice(rpcOffset).some(call => call.path === '/wallet/broadcasttransaction')).toBe(false);
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'gwdc-c03-http-'));
  ledgerPath = join(directory, 'approval.sqlite');
  controlPath = join(directory, 'rpc-control.json');
  logPath = join(directory, 'rpc-log.jsonl');
  control();
  writeFileSync(logPath, '');
  port = await unusedPort();
  child = spawn(process.execPath, ['--import', fixture, '--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(), stdio: 'ignore', env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      API_PORT: String(port), UI_PORT: '5173',
      GWDC_APPROVAL_LEDGER_KEY_HEX: randomBytes(32).toString('hex'),
      GWDC_APPROVAL_LEDGER_PATH: ledgerPath,
      GWDC_TEST_RPC_CONTROL: controlPath, GWDC_TEST_RPC_LOG: logPath,
    },
  });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch { /* Child process is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('C-03 approval HTTP fixture did not start');
}, 12_000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    await new Promise<void>(resolve => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2_000).unref();
    });
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('C-03 Nile A approval HTTP preflight gate', () => {
  it('rejects 429, timeout, and contradictory live RPC values before an intent or signed payload exists', async () => {
    const privateKey = randomBytes(32).toString('hex');
    const address = TronWeb.address.fromPrivateKey(privateKey);
    if (!address) throw new Error('시험 지갑 생성 실패');
    const confirmedNeeds = needs();
    const normalPreview = await previewFor(address, confirmedNeeds);
    const cookie = await authenticate(address, privateKey);

    for (const [label, fault] of [
      ['precise account timeout', { path: '/wallet/getaccount', method: 'GET', kind: 'timeout' }],
      ['energy estimate 429', { path: '/wallet/estimateenergy', method: 'POST', kind: '429' }],
      ['energy estimate timeout', { path: '/wallet/estimateenergy', method: 'POST', kind: 'timeout' }],
    ] as const) {
      control({ faults: [fault] });
      const offset = rpcCalls().length;
      const response = await post('/api/approval/reserve', {
        preview: normalPreview, confirmedPreviewId: normalPreview.id, needs: confirmedNeeds,
      }, cookie);
      expect(response.status, `${label}: ${await response.text()}`).not.toBe(200);
      const newCalls = rpcCalls().slice(offset);
      expect(newCalls.some(call => call.fault === fault.kind && call.path === fault.path), label).toBe(true);
      expect(newCalls.some(call => call.path === '/wallet/triggersmartcontract'), label).toBe(false);
      await assertNoIntentOrPayload(cookie, normalPreview, offset);
    }

    // The quote reader and transaction reader both return plausible, fresh values,
    // but disagree on market cash throughout planning, preview, and reserve.
    control({ values: { quoteCashSun: '1200000000', previewCashSun: '1000000000' } });
    const mismatchedPreview = await previewFor(address, confirmedNeeds);
    const mismatchOffset = rpcCalls().length;
    const mismatch = await post('/api/approval/reserve', {
      preview: mismatchedPreview, confirmedPreviewId: mismatchedPreview.id, needs: confirmedNeeds,
    }, cookie);
    expect(mismatch.status).toBe(409);
    expect(await mismatch.text()).toContain('시장 현금이 일치하지');
    await assertNoIntentOrPayload(cookie, mismatchedPreview, mismatchOffset);

    // A 429 from the separate planning-quote RPC is also fail closed.
    control({ faults: [{ path: '/wallet/getaccount', method: 'POST', kind: '429' }] });
    const quoteOffset = rpcCalls().length;
    const quoteFailure = await post('/api/approval/reserve', {
      preview: normalPreview, confirmedPreviewId: normalPreview.id, needs: confirmedNeeds,
    }, cookie);
    expect(quoteFailure.status).not.toBe(200);
    expect(rpcCalls().slice(quoteOffset).some(call => call.path === '/wallet/getaccount' &&
      call.method === 'POST' && call.fault === '429')).toBe(true);
    await assertNoIntentOrPayload(cookie, normalPreview, quoteOffset);
  }, 60_000);
});
