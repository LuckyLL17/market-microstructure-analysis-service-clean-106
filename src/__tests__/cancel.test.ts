import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MarketEngine } from '../engine.js';
import type { MarketEvent } from '../types.js';

const SYMBOL = 'ALPHA';

function restingBuy(engine: MarketEngine, strategyId: string, price = 100.01, quantity = 50) {
  const result = engine.submitOrder({ strategyId, symbol: SYMBOL, side: 'buy', orderType: 'limit', price, quantity });
  assert.equal(result.accepted, true);
  assert.equal(result.fills.length, 0, '限价单应挂在盘口上而不是立即成交');
  const resting = engine.book(SYMBOL).findOrder(result.orderId);
  assert.ok(resting, '订单应存在于订单簿');
  assert.equal(resting!.remaining, quantity);
  return result.orderId;
}

function tradeEvent(aggressorSide: 'buy' | 'sell', quantity: number, sequence = 100): MarketEvent {
  return { id: `T-${sequence}`, symbol: SYMBOL, tradingDay: '2026-09-30', timestamp: '2026-09-30T10:00:00.000Z', sequence, type: 'trade', aggressorSide, price: 100.01, quantity };
}

describe('撤单链路', () => {
  let engine: MarketEngine;
  beforeEach(() => { engine = new MarketEngine(); });

  it('正常取消：属主可以撤销自己的未结订单，订单簿与撤单频率同步更新', () => {
    const before = engine.book(SYMBOL).snapshot(20);
    const orderId = restingBuy(engine, 'A');
    const levelWithOrder = engine.book(SYMBOL).snapshot(20).bids.find(level => level.price === 100.01)!;
    assert.equal(levelWithOrder.quantity, before.bids.find(level => level.price === 100.01)!.quantity + 50);

    assert.equal(engine.cancel('A', orderId), true);

    assert.equal(engine.book(SYMBOL).findOrder(orderId), undefined);
    const after = engine.book(SYMBOL).snapshot(20);
    assert.deepEqual(after.bids, before.bids, '撤单后盘口应恢复到下单前');
    assert.deepEqual(after.asks, before.asks);
    assert.deepEqual(engine.account('A').cancelInWindow.length, 1);
  });

  it('跨策略取消：B 无法撤销 A 的挂单，A 的订单、盘口、双方账户均不变', () => {
    const orderId = restingBuy(engine, 'A', 100.01, 40);
    const before = engine.book(SYMBOL).snapshot(20);
    const accountABefore = { ...engine.account('A'), position: { ...engine.account('A').position } };

    assert.equal(engine.cancel('B', orderId), false);

    const order = engine.book(SYMBOL).findOrder(orderId);
    assert.ok(order, 'A 的订单必须仍在订单簿');
    assert.equal(order!.owner, 'A');
    assert.equal(order!.remaining, 40);
    assert.deepEqual(engine.book(SYMBOL).snapshot(20), before, '盘口不得变化');
    assert.equal(engine.accounts.get('B'), undefined, '不得为未成功撤单的陌生策略创建账户');
    assert.deepEqual(engine.account('A').cancelInWindow, []);
    const accountAAfter = engine.account('A');
    assert.equal(accountAAfter.cash, accountABefore.cash);
    assert.equal(accountAAfter.position[SYMBOL], accountABefore.position[SYMBOL]);
  });

  it('重复取消：同一订单第二次撤单返回 false 且不重复记录撤单频率', () => {
    const orderId = restingBuy(engine, 'A');

    assert.equal(engine.cancel('A', orderId), true);
    assert.equal(engine.cancel('A', orderId), false);
    assert.equal(engine.cancel('A', orderId), false);

    assert.equal(engine.book(SYMBOL).findOrder(orderId), undefined);
    assert.equal(engine.account('A').cancelInWindow.length, 1, '只有真正成功的撤单才能计数');
  });

  it('未知订单：撤不存在的订单不改变订单簿、账户状态，也不留下审计事件', () => {
    const before = engine.book(SYMBOL).snapshot(20);
    const anomaliesBefore = engine.anomalies.length;

    assert.equal(engine.cancel('ghost', 'SIM-DOES-NOT-EXIST'), false);
    assert.equal(engine.cancel('A', 'SIM-DOES-NOT-EXIST'), false);

    assert.equal(engine.accounts.get('ghost'), undefined, '未知策略不得被隐式开户');
    assert.deepEqual(engine.account('A').cancelInWindow, []);
    assert.deepEqual(engine.book(SYMBOL).snapshot(20), before);
    assert.equal(engine.anomalies.length, anomaliesBefore);
  });

  it('已成交订单不属于未结订单：撤单返回 false 且不计数', () => {
    const result = engine.submitOrder({ strategyId: 'A', symbol: SYMBOL, side: 'buy', orderType: 'market', price: 100.02, quantity: 20 });
    assert.equal(result.accepted, true);
    assert.equal(result.fills.length, 1);

    assert.equal(engine.cancel('A', result.orderId), false);
    assert.deepEqual(engine.account('A').cancelInWindow, []);
  });

  it('取消后再次成交：被撤订单不再参与撮合，策略仍可用新订单正常成交', () => {
    const orderId = restingBuy(engine, 'A', 100.01, 50);
    assert.equal(engine.cancel('A', orderId), true);

    // 一笔卖方主动成交会吃掉 100.01 的全部 172 手种子挂单；
    // 若 A 的撤单没有真正移出订单簿，被撤的 50 手也会被吃掉。
    engine.ingest(tradeEvent('sell', 200));

    assert.equal(engine.book(SYMBOL).findOrder(orderId), undefined);
    const topBid = engine.book(SYMBOL).snapshot(20).bids[0]!;
    assert.notEqual(topBid.price, 100.01, '被撤订单所在价位应被完全吃光且不含被撤数量');
    assert.equal(topBid.price, 99.99);
    assert.equal(topBid.quantity, 252 - 28);
    assert.equal(engine.fills.some(fill => fill.orderId === orderId), false, '被撤订单不得产生任何成交');
    const positionAfterSweep = engine.account('A').position[SYMBOL] ?? 0;
    assert.equal(positionAfterSweep, 0, 'A 的账户不应受行情成交影响');

    // 撤单后策略仍能正常下单并立即成交。
    const again = engine.submitOrder({ strategyId: 'A', symbol: SYMBOL, side: 'buy', orderType: 'market', price: 100.02, quantity: 20 });
    assert.equal(again.accepted, true);
    assert.equal(again.fills.length, 1);
    assert.equal(again.fills[0].orderId, again.orderId);
    assert.equal(again.fills[0].strategyId, 'A');
    assert.equal(engine.account('A').position[SYMBOL], 20);
  });
});
