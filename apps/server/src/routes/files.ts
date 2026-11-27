import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { languageTagSchema } from '@ajwf/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../app';
import { errorBody } from '../http-errors';

const DOC_CACHE = 'public, max-age=300';

/** Health check, composed sprites and the agent-facing docs (`public-docs/`), outside the `/api` prefix. */
export function fileRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { render, config } = ctx;
  const cors = { config: { cors: true } };
  const notFound = (reply: FastifyReply) => reply.code(404).send(errorBody(render.apiError('en', 'NOT_FOUND', 'not_found')));

  app.get('/healthz', cors, async () => ({ ok: true, store: ctx.game.store.kind, agents: ctx.game.state.agents.size }));

  app.get<{ Params: { file: string } }>('/sprites/:file', cors, async (req, reply) => {
    const m = /^([0-9a-f]{14})\.png$/.exec(req.params.file);
    const png = m ? await ctx.sprites.png(m[1]!) : null;
    if (!png) return notFound(reply);
    return reply.type('image/png').header('cache-control', 'public, max-age=31536000, immutable').send(png);
  });

  app.get<{ Params: { file: string } }>('/sprites/npc/:file', cors, async (req, reply) => {
    const m = /^([a-z0-9_]{1,64})\.png$/.exec(req.params.file);
    const png = m ? await ctx.sprites.npcPng(m[1]!) : null;
    if (!png) return notFound(reply);
    return reply.type('image/png').header('cache-control', 'public, max-age=86400').send(png);
  });

  /** Serves a markdown file with `{{BASE_URL}}` filled in; null when the file does not exist (yet). */
  async function doc(file: string): Promise<string | null> {
    const text = await readFile(join(ctx.docsDir, file), 'utf8').catch(() => null);
    return text === null ? null : text.replaceAll('{{BASE_URL}}', config.publicUrl);
  }

  const sendDoc = (reply: FastifyReply, text: string | null) =>
    text === null ? notFound(reply) : reply.type('text/markdown; charset=utf-8').header('cache-control', DOC_CACHE).send(text);

  app.get('/skill.md', cors, async (_req, reply) => sendDoc(reply, await doc('skill.md')));
  app.get('/heartbeat.md', cors, async (_req, reply) => sendDoc(reply, await doc('heartbeat.md')));

  /** `/skill.<lang>.md`: the exact translation, else one for the base language, else English. */
  app.get<{ Params: { file: string } }>('/:file', cors, async (req, reply) => {
    const m = /^skill\.(.+)\.md$/.exec(req.params.file);
    const tag = m && languageTagSchema.safeParse(m[1]).success ? m[1]!.toLowerCase() : null;
    // Anything else at the root may be a page of the web app (`/village`): the not-found handler decides.
    if (!tag) return reply.callNotFound();
    const files = await readdir(ctx.docsDir).catch(() => [] as string[]);
    const langOf = (f: string) => /^skill\.(.+)\.md$/.exec(f)?.[1]?.toLowerCase();
    const exact = files.find((f) => langOf(f) === tag);
    const base = tag.split('-')[0];
    const sameBase = files.find((f) => langOf(f)?.split('-')[0] === base);
    return sendDoc(reply, await doc(exact ?? sameBase ?? 'skill.md'));
  });
}
