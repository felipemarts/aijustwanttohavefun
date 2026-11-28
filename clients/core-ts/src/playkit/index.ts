/**
 * The playkit, ported from `clients/playkit` (README section 1, the decision seam). `Playkit` is the brain the core
 * thinks with; everything else (HTTP, storage, scheduling) is the core's business. Every function here is
 * deterministic and is checked byte for byte against `clients/playkit/vectors`.
 */
import type { JV } from './jv.ts';
import { Kit } from './kit.ts';
import { decide, resolve } from './decide.ts';
import { applyCompaction, chatTurn, compactionTurn, heard, recentOf, remember } from './memory.ts';
import { buildTurn, nextStep, retryMessages } from './prompt.ts';
import { parseSchemaDoc, type Menu, type SchemaDoc } from './schema.ts';
import { observe, worldPath } from './world.ts';
import type { ChatInput, ChatLine, Decision, GameErr, Memory, Message, Recent, Resolution, Turn, TurnInput, World } from './types.ts';

export class Playkit {
  readonly kit: Kit;
  constructor(kit: Kit = new Kit()) {
    this.kit = kit;
  }

  get version(): string {
    return this.kit.version;
  }

  parseSchemaDoc(body: string | JV): SchemaDoc {
    return parseSchemaDoc(body);
  }
  buildTurn(doc: SchemaDoc, input: TurnInput): Turn {
    return buildTurn(this.kit, doc, input);
  }
  retryMessages(base: Message[], answer: string, problem: string): Message[] {
    return retryMessages(this.kit, base, answer, problem);
  }
  decide(raw: string, menu: Menu): { decision: Decision } | { problem: string } {
    return decide(this.kit, raw, menu);
  }
  resolve(menu: Menu, first: string, retry: ((problem: string) => Promise<string>) | null): Promise<Resolution> {
    return resolve(this.kit, menu, first, retry);
  }
  heard(messages: JV | undefined): { chat: ChatLine[]; events: string[] } {
    return heard(messages);
  }
  remember(memory: Memory, recent: Recent | null, note: string, chat: ChatLine[]): boolean {
    return remember(this.kit, memory, recent, note, chat);
  }
  recentOf(action: string, params: JV, ok: boolean, narration: string, error?: GameErr): Recent {
    return recentOf(action, params, ok, narration, error);
  }
  observe(world: World, observation: JV): void {
    observe(this.kit, world, observation);
  }
  path(world: World, from: string, to: string): string[] {
    return worldPath(world, from, to);
  }
  nextStep(observation: JV, me: JV, world: World): string {
    return nextStep(this.kit, observation, me, world);
  }
  compactionTurn(name: string, notes: string[]): ReturnType<typeof compactionTurn> {
    return compactionTurn(this.kit, name, notes);
  }
  applyCompaction(raw: string, notes: string[]): string[] {
    return applyCompaction(this.kit, raw, notes);
  }
  chatTurn(input: ChatInput): Message[] {
    return chatTurn(this.kit, input);
  }
  wakes(event: JV, name: string): boolean {
    return this.kit.wakes(event, name);
  }
  refreshesMe(action: string): boolean {
    return this.kit.refreshesMe(action);
  }
}

export { Kit, type Config, type PaceName } from './kit.ts';
export * from './types.ts';
export { SchemaDoc, ACTION_STEPS, MENU_STEPS, buildMenu, findAction, menuNames, paramsText, resting, signature, source, type Menu, type MenuAction, type ActionStep, type MenuStep } from './schema.ts';
export { ERR_NOT_JSON, extract, validateSchema } from './decide.ts';
export * as jv from './jv.ts';
export * as text from './text.ts';
export * from './codec.ts';
