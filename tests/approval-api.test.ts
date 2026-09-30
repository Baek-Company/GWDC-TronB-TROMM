import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Trx, TronWeb } from 'tronweb';

let child: ChildProcess;
let port: number;
let directory: string;
const origin = 'http://127.0.0.1:5173';

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

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'gwdc-approval-api-'));
  port = await unusedPort();
  child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(), stdio: 'ignore',
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      API_PORT: String(port), UI_PORT: '5173',
      GWDC_APPROVAL_LEDGER_KEY_HEX: randomBytes(32).toString('hex'),
      GWDC_APPROVAL_LEDGER_PATH: join(directory, 'ledger.sqlite'),
    },
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch { /* Starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Approval API did not start');
}, 10_000);

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

async function post(path: string, body: unknown, cookie?: string, originHeader: string | null = origin) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: {
      'Content-Type': 'application/json', ...(originHeader ? { Origin: originHeader } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    }, body: JSON.stringify(body),
  });
}

describe('Nile approval HTTP boundary', () => {
  it('blocks unauthenticated requests and accepts only a one-time wallet proof', async () => {
    const privateKey = randomBytes(32).toString('hex');
    const address = TronWeb.address.fromPrivateKey(privateKey);
    if (!address) throw new Error('시험 지갑 생성 실패');
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(await health.json()).toMatchObject({ nileApprovalLedgerReady: true });
    expect((await post('/api/approval/challenge', { address }, undefined, null)).status).toBe(403);
    expect((await post('/api/approval/challenge', { address }, undefined, 'https://example.com')).status).toBe(403);
    expect((await post('/api/approval/reserve', { preview: {}, confirmedPreviewId: 'x' })).status).toBe(401);
    const challengeResponse = await post('/api/approval/challenge', { address });
    expect(challengeResponse.status).toBe(200);
    const challenge = await challengeResponse.json() as { challengeId: string; message: string; expiresAt: string };
    expect(challenge.message).toContain(address);
    const wrongKey = randomBytes(32).toString('hex');
    const wrong = await post('/api/approval/authenticate', { challengeId: challenge.challengeId,
      address, signature: Trx.signMessageV2(challenge.message, wrongKey) });
    expect(wrong.status).toBe(409);
    const replay = await post('/api/approval/authenticate', { challengeId: challenge.challengeId,
      address, signature: Trx.signMessageV2(challenge.message, privateKey) });
    expect(replay.status).toBe(409);
    const newChallengeResponse = await post('/api/approval/challenge', { address });
    const next = await newChallengeResponse.json() as typeof challenge;
    const authenticated = await post('/api/approval/authenticate', {
      challengeId: next.challengeId, address, signature: Trx.signMessageV2(next.message, privateKey),
    });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toMatchObject({ account: address });
    const cookie = authenticated.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toMatch(/^gwdc_nile_approval=[0-9a-f]{64}$/);
    const unresolved = await fetch(`http://127.0.0.1:${port}/api/approval/unresolved`, { headers: { Cookie: cookie! } });
    expect(unresolved.status).toBe(200);
    expect(await unresolved.json()).toEqual({ intents: [] });
    expect((await post('/api/approval/reserve', { preview: {}, confirmedPreviewId: 'x' }, cookie,
      'http://localhost:5173')).status).toBe(401);
    expect((await post('/api/approval/reserve', { preview: {}, confirmedPreviewId: 'x' }, cookie,
      'https://example.com')).status).toBe(403);
    const crossSite = await fetch(`http://127.0.0.1:${port}/api/approval/unresolved`, {
      headers: { Cookie: cookie!, 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
    expect((await post('/api/approval/reserve', { preview: {}, confirmedPreviewId: 'x' }, cookie)).status).toBe(400);
    expect((await post('/api/approval/cancel', { intentId: 'a'.repeat(64) }, cookie)).status).toBe(409);
  });
});
