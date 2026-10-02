import assert from 'node:assert/strict';
import { MarketEngine } from '../src/engine.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const levelQty = (engine: MarketEngine, symbol: string, price: number): number =>
  engine.book(symbol).snapshot(20).bids.find(level => level.price === price)?.quantity ?? 0;
const hasLevel = (engine: MarketEngine, symbol: string, price: number): boolean =>
  engine.book(symbol).snapshot(20).bids.some(level => level.price === price);
/** 用市价卖单持续扫掉买盘，直到目标价位被吃掉（绕过持仓/资金限制的测试夹具）。 */
function sweepBidsThrough(engine: MarketEngine, symbol: string, price: number): void {
  engine.account('SWEEPER').position[symbol] = 100_000;
  for (let i = 0; hasLevel(engine, symbol, price) && i < 30; i++) {
    const result = engine.submitOrder({ strategyId: 'SWEEPER', symbol, side: 'sell', orderType: 'market', quantity: 400 });
    assert.equal(result.accepted, true, `扫单用卖单应被接受: ${JSON.stringify(result.risk)}`);
  }
  assert.equal(hasLevel(engine, symbol, price), false, '清扫后目标价位应已完全成交');
}

// 1. 跨策略取消：B 不能取消 A 的挂单，盘口、A 的订单、B/A 的账户状态都不变
test('跨策略取消被拒绝且不产生任何副作用', () => {
  const engine = new MarketEngine();
  const price = engine.book('ALPHA').snapshot().bids[0].price;
  const before = levelQty(engine, 'ALPHA', price);

  const a = engine.submitOrder({ strategyId: 'A', symbol: 'ALPHA', side: 'buy', orderType: 'limit', price, quantity: 100 });
  assert.equal(a.accepted, true);
  assert.equal(a.fills.length, 0, 'A 的限价单应挂在盘口上');
  assert.equal(levelQty(engine, 'ALPHA', price), before + 100);

  assert.equal(engine.cancel('B', a.orderId), false);
  assert.equal(engine.accounts.has('B'), false, '失败的撤单不应为 B 创建账户/撤单频率记录');
  assert.equal(engine.accounts.get('A')!.cancelInWindow.length, 0, 'A 的撤单频率不应受 B 影响');
  assert.equal(levelQty(engine, 'ALPHA', price), before + 100, 'B 撤单失败后 A 的订单必须仍在盘口');

  // A 自己仍然可以撤掉这张单，证明 B 的尝试没有改变订单状态
  assert.equal(engine.cancel('A', a.orderId), true);
  assert.equal(levelQty(engine, 'ALPHA', price), before);
});

// 2. 正常取消：属主取消自己的未结订单成功，盘口移除，撤单频率记录一次
test('属主正常取消自己的未结订单', () => {
  const engine = new MarketEngine();
  const price = engine.book('ALPHA').snapshot().bids[0].price;
  const before = levelQty(engine, 'ALPHA', price);
  const order = engine.submitOrder({ strategyId: 'A', symbol: 'ALPHA', side: 'buy', orderType: 'limit', price, quantity: 55 });
  assert.equal(levelQty(engine, 'ALPHA', price), before + 55);

  assert.equal(engine.cancel('A', order.orderId), true);
  assert.equal(levelQty(engine, 'ALPHA', price), before);
  assert.equal(engine.accounts.get('A')!.cancelInWindow.length, 1);
});

// 3. 重复取消：第二次撤单返回 false，不重复记账、不改动盘口
test('重复取消返回 false 且不重复记录频率', () => {
  const engine = new MarketEngine();
  const price = engine.book('ALPHA').snapshot().bids[0].price;
  const before = levelQty(engine, 'ALPHA', price);
  const order = engine.submitOrder({ strategyId: 'A', symbol: 'ALPHA', side: 'buy', orderType: 'limit', price, quantity: 80 });

  assert.equal(engine.cancel('A', order.orderId), true);
  assert.equal(engine.cancel('A', order.orderId), false);
  assert.equal(engine.cancel('A', order.orderId), false);
  assert.equal(engine.accounts.get('A')!.cancelInWindow.length, 1, '撤单频率只能记录一次');
  assert.equal(levelQty(engine, 'ALPHA', price), before);
});

// 4. 未知订单：返回 false，不创建账户、不记录撤单频率、不触碰任何盘口
test('未知订单取消返回 false 且无副作用', () => {
  const engine = new MarketEngine();
  const price = engine.book('ALPHA').snapshot().bids[0].price;
  const before = levelQty(engine, 'ALPHA', price);

  assert.equal(engine.cancel('STRANGER', 'SIM-does-not-exist'), false);
  assert.equal(engine.accounts.has('STRANGER'), false, '不应为未知撤单方创建账户');

  const order = engine.submitOrder({ strategyId: 'A', symbol: 'ALPHA', side: 'buy', orderType: 'limit', price, quantity: 10 });
  assert.equal(engine.cancel('A', 'SIM-not-there'), false);
  assert.equal(engine.accounts.get('A')!.cancelInWindow.length, 0, '撤未知单不能计入 A 的撤单频率');
  assert.equal(levelQty(engine, 'ALPHA', price), before + 10, '真实挂单不受影响');
  assert.equal(engine.cancel('A', order.orderId), true);

  // 撤单频率记录不能污染后续风控（60 秒窗口内）
  for (let i = 0; i < 5; i++) engine.cancel('A', 'SIM-ghost');
  const next = engine.submitOrder({ strategyId: 'A', symbol: 'ALPHA', side: 'buy', orderType: 'limit', price, quantity: 10 });
  assert.equal(next.accepted, true);
});

// 5a. 已成交订单不能再取消，撤单频率不增加
test('订单完全成交后取消返回 false（取消后再次成交的镜像场景）', () => {
  const engine = new MarketEngine();
  const price = 99.5; // A 独占的价位
  const order = engine.submitOrder({ strategyId: 'A', symbol: 'ALPHA', side: 'buy', orderType: 'limit', price, quantity: 100 });
  assert.equal(order.accepted, true);
  assert.equal(levelQty(engine, 'ALPHA', price), 100);

  sweepBidsThrough(engine, 'ALPHA', price);
  assert.equal(engine.cancel('A', order.orderId), false, '已成交订单不可取消');
  assert.equal(engine.accounts.get('A')!.cancelInWindow.length, 0, '取消已成交订单不能记录撤单频率');
});

// 5b. 已取消的订单不会被后续成交“复活”：同价位对照单 F 被成交，A 的取消单不产生任何成交
test('取消后再次成交：已取消订单不参与撮合、账户状态不变', () => {
  const engine = new MarketEngine();
  const price = engine.book('ALPHA').snapshot().bids[0].price;
  const aOrder = engine.submitOrder({ strategyId: 'A', symbol: 'ALPHA', side: 'buy', orderType: 'limit', price, quantity: 100 });
  const fOrder = engine.submitOrder({ strategyId: 'F', symbol: 'ALPHA', side: 'buy', orderType: 'limit', price, quantity: 100 });

  const aAccount = engine.accounts.get('A')!;
  const aCash = aAccount.cash;
  assert.equal(engine.cancel('A', aOrder.orderId), true);
  assert.equal(aAccount.cancelInWindow.length, 1);

  sweepBidsThrough(engine, 'ALPHA', price);

  // 同价位未撤的对照单确实被吃到（证明清扫覆盖了该价位），其状态为已成交而非已取消
  assert.equal(engine.cancel('F', fOrder.orderId), false);
  assert.equal(engine.accounts.get('F')!.cancelInWindow.length, 0, '对照单是被成交的，撤单返回 false 且不记账');

  // A 的已取消订单没有被成交、没有复活，账户与频率记录保持取消时的状态
  assert.equal(engine.cancel('A', aOrder.orderId), false);
  assert.equal(aAccount.cancelInWindow.length, 1);
  assert.equal(aAccount.cash, aCash);
  assert.deepEqual(aAccount.position, {});
  assert.equal(engine.fills.filter(fill => fill.strategyId === 'A').length, 0, 'A 不应出现任何成交记录');
});

// 6. HTTP 层返回结构保持 { cancelled: boolean }
test('撤单接口返回结构保持不变', async () => {
  const { cancelResponseShape } = await import('./http-shape-check.js');
  const shapes = await cancelResponseShape();
  assert.deepEqual(shapes.success, { cancelled: true });
  assert.deepEqual(shapes.foreign, { cancelled: false });
  assert.deepEqual(shapes.unknown, { cancelled: false });
});

console.log(`\n${passed} 个撤单链路测试全部通过`);
