import { BALANCE } from './balance';
import type { BoardPost, BoardReply, WorldState } from './types';

/**
 * The notice board: the latest posts, oldest first, in `s.board`. Each post is its own snapshot entry
 * (`post:<id>`): a post or a reply rewrites that post only, and a post that leaves the board (trimmed or removed
 * by a moderator) is exported as a null entry, which the store deletes. Older snapshots kept the whole board under
 * one `board` key; `restoreBoard` reads it and migrates it to entries per post.
 *
 * What the board keeps in memory is bounded twice: at most `maxPosts` posts, and at most `maxTextBytes` of agent
 * text (posts and replies, counted as UTF-16, the way the engine holds them). Over either line, the oldest posts go.
 */

export const postKey = (id: string): string => `post:${id}`;

/** Bytes of agent text a post holds in memory, replies included. */
export function postBytes(p: BoardPost): number {
  let n = p.text.length;
  for (const r of p.replies) n += r.text.length;
  return 2 * n;
}

function markPost(s: WorldState, id: string): void {
  s.dirty.add(postKey(id));
}

/** Drops the oldest posts while the board is over its limits. `keep` (the post just written to) goes last. */
function trimBoard(s: WorldState, keep?: BoardPost): void {
  const B = BALANCE.board;
  while (s.board.length > B.maxPosts || (s.boardBytes > B.maxTextBytes && s.board.length > 1)) {
    const i = s.board[0] === keep && s.board.length > 1 ? 1 : 0;
    const [gone] = s.board.splice(i, 1);
    s.boardBytes -= postBytes(gone!);
    markPost(s, gone!.id);
  }
}

export function addPost(s: WorldState, post: BoardPost): void {
  s.board.push(post);
  s.boardBytes += postBytes(post);
  markPost(s, post.id);
  trimBoard(s, post);
}

export function addReply(s: WorldState, post: BoardPost, reply: BoardReply): void {
  post.replies.push(reply);
  s.boardBytes += 2 * reply.text.length;
  markPost(s, post.id);
  trimBoard(s, post);
}

/** What `removeBoardPost` took off the board: the whole post (with its replies), or one reply of a post that stays. */
export type RemovedBoardPost = { post: BoardPost; reply?: BoardReply };

/**
 * Moderation: removes a post with its replies or, given `replyIndex`, only that reply (later replies move up one).
 * Post ids are never reused (`meta.postSeq` stays), and lifetime stats such as `board_posts` keep counting what the
 * author did. Returns what was removed, or null when the post or reply does not exist.
 */
export function removeBoardPost(s: WorldState, postId: string, replyIndex?: number): RemovedBoardPost | null {
  const idx = s.board.findIndex((p) => p.id === postId);
  const post = s.board[idx];
  if (!post) return null;
  if (replyIndex === undefined) {
    s.board.splice(idx, 1);
    s.boardBytes -= postBytes(post);
    markPost(s, post.id);
    return { post };
  }
  if (!Number.isInteger(replyIndex) || replyIndex < 0) return null;
  const reply = post.replies[replyIndex];
  if (!reply) return null;
  post.replies.splice(replyIndex, 1);
  s.boardBytes -= 2 * reply.text.length;
  markPost(s, post.id);
  return { post, reply };
}

/** The snapshot entry of a post key: the post while it is on the board, null once it left (the store drops it). */
export function postEntry(s: WorldState, id: string): BoardPost | null {
  return s.board.find((p) => p.id === id) ?? null;
}

const seqOf = (id: string): number => parseInt(id.slice(1), 36);

function validPost(x: unknown): x is BoardPost {
  const p = x as Partial<BoardPost> | null;
  return (
    !!p &&
    typeof p.id === 'string' &&
    /^b[0-9a-z]+$/.test(p.id) &&
    typeof p.by === 'string' &&
    typeof p.text === 'string' &&
    typeof p.at === 'number' &&
    Array.isArray(p.replies) &&
    p.replies.every((r) => !!r && typeof r.text === 'string' && typeof r.by === 'string')
  );
}

/**
 * Rebuilds the board from `post:<id>` entries and, for snapshots written before them, the legacy `board` array
 * (per-post entries win). Returns the keys to mark dirty once the restore is done: every migrated post, and `board`
 * itself, whose entry is now null so that the store drops the legacy row.
 */
export function restoreBoard(s: WorldState, world: Map<string, unknown>): string[] {
  const byId = new Map<string, BoardPost>();
  const legacy = world.get('board');
  const migrate: string[] = [];
  if (Array.isArray(legacy)) {
    for (const p of legacy) if (validPost(p)) byId.set(p.id, p);
    migrate.push('board', ...[...byId.keys()].map(postKey));
  }
  for (const [key, data] of world) if (key.startsWith('post:') && validPost(data) && postKey(data.id) === key) byId.set(data.id, data);
  s.board = [...byId.values()].sort((x, y) => seqOf(x.id) - seqOf(y.id));
  s.boardBytes = s.board.reduce((n, p) => n + postBytes(p), 0);
  const before = s.board.map((p) => p.id);
  trimBoard(s);
  // Posts trimmed on the way in (the limits may have been lowered) are dropped from the store as well.
  const kept = new Set(s.board.map((p) => p.id));
  for (const id of before) if (!kept.has(id)) migrate.push(postKey(id));
  return migrate;
}
