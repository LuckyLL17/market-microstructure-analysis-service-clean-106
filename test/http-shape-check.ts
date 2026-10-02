import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

export async function cancelResponseShape(): Promise<{ success: unknown; foreign: unknown; unknown: unknown }> {
  const app: FastifyInstance = buildServer();
  try {
    const order = await app.inject({
      method: 'POST',
      url: '/api/sandbox/orders',
      payload: { strategyId: 'A', symbol: 'ALPHA', side: 'buy', orderType: 'limit', price: 99.5, quantity: 100 },
    });
    const { orderId } = order.json<{ orderId: string }>();

    const foreign = (await app.inject({
      method: 'POST', url: '/api/sandbox/cancel', payload: { strategyId: 'B', orderId },
    })).json();
    const success = (await app.inject({
      method: 'POST', url: '/api/sandbox/cancel', payload: { strategyId: 'A', orderId },
    })).json();
    const unknown = (await app.inject({
      method: 'POST', url: '/api/sandbox/cancel', payload: { strategyId: 'A', orderId: 'SIM-nope' },
    })).json();

    return { success, foreign, unknown };
  } finally {
    await app.close();
  }
}
