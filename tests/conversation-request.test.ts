import { describe, expect, it } from 'vitest';
import { RequestGate } from '../src/features/conversation/requestGate';

describe('conversation request generation', () => {
  it('invalidates an old reply after reset and preserves a newer request', async () => {
    const gate = new RequestGate();
    const first = gate.start();
    let finishFirst!: () => void;
    const lateReply = new Promise<void>(resolve => { finishFirst = resolve; });
    gate.cancel();
    const second = gate.start();
    finishFirst();
    await lateReply;
    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  it('invalidates pending work when a component unmounts', () => {
    const gate = new RequestGate();
    const pending = gate.start();
    gate.cancel();
    expect(pending.isCurrent()).toBe(false);
    expect(pending.signal.aborted).toBe(true);
  });
});
