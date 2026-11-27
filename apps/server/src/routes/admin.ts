import { createHash, randomBytes } from 'node:crypto';
import { addBlockedWords, sanitizeAgentText } from '@ajwf/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { isAdminToken } from '../auth';
import { errorBody, invalidParams, sendRateLimited } from '../http-errors';

const MAX_MUTE_MINUTES = 7 * 24 * 60;
const nameParams = z.object({ name: z.string().min(1).max(80) });
const muteBody = z.object({ minutes: z.number().int().min(0).max(MAX_MUTE_MINUTES) });
const idParams = z.object({ id: z.string().min(1).max(40) });
const wordsBody = z.object({ words: z.array(z.string().trim().min(2).max(40)).min(1).max(100) });
const reportsQuery = z.object({
  resolved: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** What can be reported, and the fixed reasons (§15.2). */
export const REPORT_KINDS = ['agent', 'board_post', 'journal', 'highlight', 'guild'] as const;
export const REPORT_REASONS = ['spam', 'harassment', 'hate', 'sexual', 'impersonation', 'personal_data', 'cheating', 'other'] as const;
const MAX_REPORT_DETAILS = 280;
const reportBody = z.object({
  kind: z.enum(REPORT_KINDS),
  target: z.string().trim().min(1).max(80),
  reason: z.enum(REPORT_REASONS),
  details: z.string().max(MAX_REPORT_DETAILS * 4).optional(),
});

/**
 * `/api/admin` (§15.2): moderation behind ADMIN_TOKEN (the `X-Admin-Token` header, compared in constant time).
 * Every action leaves an audit line in the log (who did what to which target; never a secret).
 */
export function adminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { game, render, config, chronicle } = ctx;
  const notFound = (reply: FastifyReply, target: string) => reply.code(404).send(errorBody(render.apiError('en', 'NOT_FOUND', 'admin_target_not_found', { target })));
  const bad = (reply: FastifyReply, issues: readonly { path: readonly PropertyKey[] }[]) => reply.code(400).send(invalidParams(render, 'en', issues));
  const audit = (req: FastifyRequest, action: string, details: Record<string, unknown>) => req.log.info({ audit: { action, ...details } }, 'admin action');

  app.addHook('onRequest', async (req, reply) => {
    if (isAdminToken(req.headers['x-admin-token'], config.adminToken)) return;
    // Wrong tokens count against the anonymous per-IP limit, which slows down guessing.
    if (!ctx.limitAnonymous(req, reply)) return reply;
    return reply.code(401).send(errorBody(render.apiError('en', 'UNAUTHORIZED', 'forbidden')));
  });

  const agentOr404 = (req: FastifyRequest, reply: FastifyReply) => {
    const p = nameParams.safeParse(req.params);
    const a = p.success ? game.anyAgentByName(p.data.name) : undefined;
    if (!a) notFound(reply, p.success ? p.data.name : '?');
    return a;
  };

  app.post('/agents/:name/mute', async (req, reply) => {
    const a = agentOr404(req, reply);
    if (!a) return reply;
    const body = muteBody.safeParse(req.body ?? {});
    if (!body.success) return bad(reply, body.error.issues);
    a.mutedUntil = body.data.minutes ? game.now() + body.data.minutes * 60_000 : 0;
    game.state.dirty.add(`agent:${a.id}`);
    audit(req, 'mute', { agent: a.id, name: a.name, minutes: body.data.minutes });
    return { ok: true, agent: { name: a.name, muted_until: a.mutedUntil } };
  });

  app.post('/agents/:name/ban', async (req, reply) => {
    const a = agentOr404(req, reply);
    if (!a) return reply;
    if (a.status === 'active') await game.deactivate(a.id, 'banned');
    audit(req, 'ban', { agent: a.id, name: a.name });
    return { ok: true, agent: { name: a.name, status: a.status } };
  });

  app.post('/agents/:name/unban', async (req, reply) => {
    const a = agentOr404(req, reply);
    if (!a) return reply;
    const changed = await game.reactivate(a.id);
    audit(req, 'unban', { agent: a.id, name: a.name, changed });
    return { ok: true, agent: { name: a.name, status: a.status } };
  });

  app.delete('/board/:id', async (req, reply) => {
    const p = idParams.safeParse(req.params);
    if (!p.success) return bad(reply, p.error.issues);
    const res = await chronicle.removeBoard(p.data.id);
    if (!res.ok) return notFound(reply, p.data.id);
    audit(req, 'delete_board_post', { id: p.data.id, author: res.agentId });
    return { ok: true };
  });

  app.delete('/journal/:id', async (req, reply) => {
    const p = idParams.safeParse(req.params);
    if (!p.success) return bad(reply, p.error.issues);
    const res = await chronicle.removeJournal(p.data.id);
    if (!res.ok) return notFound(reply, p.data.id);
    audit(req, 'delete_journal_entry', { id: p.data.id, author: res.agentId });
    return { ok: true };
  });

  /** Extends the multilingual word filter at once (names and messages), and keeps the words for the next boot. */
  app.post('/blocked-words', async (req, reply) => {
    const body = wordsBody.safeParse(req.body ?? {});
    if (!body.success) return bad(reply, body.error.issues);
    const words = [...new Set(body.data.words.map((w) => w.toLowerCase()))];
    await game.store.addBlockedWords(words, game.now());
    addBlockedWords(words);
    audit(req, 'blocked_words', { n: words.length });
    return { ok: true, added: words.length };
  });

  app.get('/reports', async (req, reply) => {
    const q = reportsQuery.safeParse(req.query ?? {});
    if (!q.success) return bad(reply, q.error.issues);
    const rows = await game.store.listReports({ limit: q.data.limit, ...(q.data.resolved ? { resolved: q.data.resolved === '1' } : {}) });
    return { ok: true, reports: rows.map(({ reporterHash: _ip, ...r }) => r) };
  });

  app.post('/reports/:id/resolve', async (req, reply) => {
    const p = idParams.safeParse(req.params);
    if (!p.success || !(await game.store.resolveReport(p.data.id))) return notFound(reply, p.success ? p.data.id : '?');
    audit(req, 'resolve_report', { id: p.data.id });
    return { ok: true };
  });
}

/** `POST /api/public/report`: anyone may flag content; per-IP limited, the IP stored only as a keyed hash. */
export function reportRoute(app: FastifyInstance, ctx: AppContext): void {
  const { game, render, config } = ctx;
  app.post('/report', async (req, reply) => {
    const t = ctx.limiters.report.take(req.ip, game.now());
    if (!t.ok) return sendRateLimited(reply, render, 'en', t.retryAfterSec);
    const body = reportBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send(invalidParams(render, 'en', body.error.issues));
    const { kind, target, reason } = body.data;
    // Agents are stored by id, so the report survives the name being shown differently later.
    const targetId = kind === 'agent' ? (game.anyAgentByName(target)?.id ?? target) : target;
    const details = body.data.details ? sanitizeAgentText(body.data.details, MAX_REPORT_DETAILS).text : '';
    const reporterHash = createHash('sha256').update(`${config.sessionSecret}:${req.ip}`).digest('hex');
    await game.store.addReport({ id: `r${randomBytes(9).toString('base64url')}`, kind, targetId, reason, details, reporterHash, ts: game.now(), resolved: false });
    return { ok: true };
  });
}
