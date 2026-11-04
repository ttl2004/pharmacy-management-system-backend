import { createFastifyAdapter } from './fastify-adapter';

describe('createFastifyAdapter', () => {
  const init = async (n: number) => {
    const adapter = createFastifyAdapter({ TRUST_PROXY: n });
    adapter.getInstance().get('/x', (req, reply) => reply.send({ ip: req.ip, id: req.id }));
    await adapter.getInstance().ready();
    return adapter.getInstance();
  };

  it('TRUST_PROXY=0 bỏ qua X-Forwarded-For', async () => {
    const app = await init(0);
    const res = await app.inject({ url: '/x', headers: { 'x-forwarded-for': '9.9.9.9' }, remoteAddress: '10.0.0.1' });
    expect(res.json<{ ip: string }>().ip).toBe('10.0.0.1');
    await app.close();
  });

  it('TRUST_PROXY=1 lấy IP client từ X-Forwarded-For', async () => {
    const app = await init(1);
    const res = await app.inject({ url: '/x', headers: { 'x-forwarded-for': '9.9.9.9' }, remoteAddress: '10.0.0.1' });
    expect(res.json<{ ip: string }>().ip).toBe('9.9.9.9');
    await app.close();
  });

  it('mỗi request có id là UUID', async () => {
    const app = await init(0);
    const res = await app.inject({ url: '/x' });
    expect(res.json<{ id: string }>().id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await app.close();
  });

  it('bỏ qua header request-id / x-request-id do client gửi', async () => {
    const app = await init(0);
    for (const name of ['request-id', 'x-request-id']) {
      const res = await app.inject({ url: '/x', headers: { [name]: 'gia-mao-123' } });
      const id = res.json<{ id: string }>().id;
      expect(id).not.toBe('gia-mao-123');
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    await app.close();
  });
});
