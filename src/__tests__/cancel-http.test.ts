import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { app, engine } from '../server.js';

const SYMBOL = 'ALPHA';

async function submit(strategyId: string, orderIdTag: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sandbox/orders',
    payload: { strategyId, symbol: SYMBOL, side: 'buy', orderType: 'limit', price: 100.01, quantity: 10 },
    headers: { 'x-tag': orderIdTag },
  });
  assert.equal(response.statusCode, 200);
  return response.json<{ accepted: boolean; orderId: string }>();
}

async function cancel(strategyId: string, orderId: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sandbox/cancel',
    payload: { strategyId, orderId },
  });
  assert.equal(response.statusCode, 200);
  return response.json();
}

describe('POST /api/sandbox/cancel', () => {
  it('返回结构保持 { cancelled: boolean }，并正确处理正常/重复/跨策略/未知撤单', async () => {
    const a = `httpA-${Date.now()}`;
    const b = `httpB-${Date.now()}`;
    const orderA = (await submit(a, 'a')).orderId;
    const orderOther = (await submit(b, 'b')).orderId;
    void orderOther;

    assert.deepEqual(await cancel(a, orderA), { cancelled: true });
    assert.deepEqual(await cancel(a, orderA), { cancelled: false });
    assert.deepEqual(await cancel(b, orderA), { cancelled: false });
    assert.deepEqual(await cancel(a, 'SIM-NO-SUCH-ORDER'), { cancelled: false });

    // 跨策略失败后，A 的订单仍可被 A 自己撤销（此处再验证 B 的订单不受 A 干扰）。
    assert.deepEqual(await cancel(a, orderOther), { cancelled: false });
    assert.ok(engine.book(SYMBOL).findOrder(orderOther));
    assert.deepEqual(await cancel(b, orderOther), { cancelled: true });
    assert.equal(engine.book(SYMBOL).findOrder(orderOther), undefined);
  });
});
