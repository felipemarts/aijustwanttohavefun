import Fastify from 'fastify';

const app = Fastify({ logger: true });
app.get('/healthz', async () => ({ ok: true }));
await app.listen({ port: Number(process.env.PORT ?? 8710), host: '0.0.0.0' });
