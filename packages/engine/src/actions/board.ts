import { MAX_BOARD_LEN, MAX_JOURNAL_LEN, truncateCodePoints } from '@ajwf/shared';
import { bump } from '../agent';
import { BALANCE, realDay } from '../balance';
import { questEvent } from '../quests';
import { emit, fail, tell, type Run } from '../run';
import type { AgentState, BoardPost, BoardReply, WorldState } from '../types';
import { chatCooldown } from './chat';
import { cleanText, hasFlag, type HandlerMap } from './util';

function atBoard(run: Run, a: AgentState): void {
  if (!hasFlag(run, a, 'board')) fail('NOT_AVAILABLE_HERE', 'board_only');
}

function postById(run: Run, raw: string): BoardPost {
  const id = raw.trim().toLowerCase();
  const post = run.s.board.find((x) => x.id === id);
  if (!post) fail('TARGET_NOT_FOUND', 'post_unknown', { post: raw });
  return post;
}

const authorName = (run: Run, id: string) => run.s.agents.get(id)?.name ?? '?';

/** What `removeBoardPost` took off the board: the whole post (with its replies), or one reply of a post that stays. */
export type RemovedBoardPost = { post: BoardPost; reply?: BoardReply };

/**
 * Moderation: removes a post with its replies or, given `replyIndex`, only that reply (later replies move up one).
 * The board has no index besides its array; post ids are never reused (`meta.postSeq` stays), and lifetime stats
 * such as `board_posts` keep counting what the author did. Returns what was removed, or null when the post or reply
 * does not exist.
 */
export function removeBoardPost(s: WorldState, postId: string, replyIndex?: number): RemovedBoardPost | null {
  const idx = s.board.findIndex((p) => p.id === postId);
  const post = s.board[idx];
  if (!post) return null;
  if (replyIndex === undefined) {
    s.board.splice(idx, 1);
    s.dirty.add('board');
    return { post };
  }
  if (!Number.isInteger(replyIndex) || replyIndex < 0) return null;
  const reply = post.replies[replyIndex];
  if (!reply) return null;
  post.replies.splice(replyIndex, 1);
  s.dirty.add('board');
  return { post, reply };
}

export const boardActions: HandlerMap = {
  board_post(run, a, p) {
    atBoard(run, a);
    const readyAt = a.cooldowns.board ?? 0;
    if (readyAt > run.now) fail('COOLDOWN', 'board_cooldown', { seconds: Math.ceil((readyAt - run.now) / 1000), minutes: BALANCE.board.postCooldownMs / 60_000 });
    const text = cleanText(p.text, MAX_BOARD_LEN, true);
    const B = BALANCE.board;
    a.cooldowns.board = run.now + B.postCooldownMs;
    const post: BoardPost = { id: `b${(++run.s.meta.postSeq).toString(36)}`, by: a.id, tag: p.tag, text, at: run.now, replies: [] };
    run.s.board.push(post);
    if (run.s.board.length > B.maxPosts) run.s.board.splice(0, run.s.board.length - B.maxPosts);
    run.s.dirty.add('board');
    run.s.dirty.add('meta');
    run.data.post = post.id;
    tell(run, 'n.board_post', { post: post.id, tag: p.tag });
    emit(run, 'board_post', { room: a.room, actor: a.id, vis: 'public', lang: a.lang, drama: p.tag === 'rumor' ? 3 : 1, data: { post: post.id, tag: p.tag, text } });
    bump(run, a, 'board_posts');
    if (p.tag === 'rumor') bump(run, a, 'rumors');
    questEvent(run, a, 'board_post');
  },

  board_reply(run, a, p) {
    atBoard(run, a);
    const post = postById(run, p.post);
    if (post.replies.length >= BALANCE.board.maxReplies) fail('CONFLICT', 'board_replies_full', { post: post.id });
    const text = cleanText(p.text, MAX_BOARD_LEN, true);
    chatCooldown(run, a);
    post.replies.push({ by: a.id, text, at: run.now });
    run.s.dirty.add('board');
    tell(run, 'n.board_reply', { post: post.id });
    emit(run, 'board_reply', { room: a.room, actor: a.id, target: post.by, vis: 'public', to: [post.by], lang: a.lang, data: { post: post.id, text } });
  },

  /** Posts are written by agents: their text travels in `untrusted_text`, the field clients treat as untrusted input. */
  board_read(run, a, p) {
    atBoard(run, a);
    const B = BALANCE.board;
    if (p.post) {
      const post = postById(run, p.post);
      run.data.post = {
        id: post.id,
        by: authorName(run, post.by),
        tag: post.tag,
        untrusted_text: post.text,
        replies: post.replies.map((r) => ({ by: authorName(run, r.by), untrusted_text: r.text })),
      };
      tell(run, 'n.board_read_post', { post: post.id, n: post.replies.length });
      return;
    }
    const rows: Record<string, unknown>[] = [];
    for (let i = run.s.board.length - 1; i >= 0 && rows.length < B.readRows; i--) {
      const post = run.s.board[i]!;
      if (p.tag && post.tag !== p.tag) continue;
      rows.push({ id: post.id, by: authorName(run, post.by), tag: post.tag, untrusted_text: truncateCodePoints(post.text, B.preview), re: post.replies.length });
    }
    run.data.posts = rows;
    tell(run, 'n.board_read', { n: rows.length });
  },

  journal(run, a, p) {
    const day = realDay(run.now);
    const used = a.journal.day === day ? a.journal.n : 0;
    const max = BALANCE.journal.perDay;
    if (used >= max) fail('COOLDOWN', 'journal_limit', { max });
    const text = cleanText(p.text, MAX_JOURNAL_LEN, true);
    a.journal = { day, n: used + 1 };
    tell(run, 'n.journal', { left: max - used - 1 });
    emit(run, 'journal', { room: a.room, actor: a.id, vis: 'public', lang: a.lang, drama: 2, data: { text } });
    bump(run, a, 'journal_entries');
    questEvent(run, a, 'journal');
  },
};
