import type { SpectatorEvent } from '@ajwf/shared';
import { SPECTATE } from './constants';

/** Fixed-size ring of the latest items; `list()` returns them oldest first. */
export class Ring<T> {
  private buf: T[] = [];
  private head = 0;

  constructor(readonly capacity: number) {}

  push(item: T): void {
    if (this.buf.length < this.capacity) this.buf.push(item);
    else {
      this.buf[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  list(): T[] {
    return this.head === 0 ? [...this.buf] : [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
  }

  get size(): number {
    return this.buf.length;
  }
}

/** The last public events of each room, in memory, for the `room:<id>` full state (only visible events get here). */
export class RoomLogs {
  private rooms = new Map<string, Ring<SpectatorEvent>>();

  constructor(private readonly size: number = SPECTATE.roomLogSize) {}

  push(room: string, ev: SpectatorEvent): void {
    let ring = this.rooms.get(room);
    if (!ring) this.rooms.set(room, (ring = new Ring(this.size)));
    ring.push(ev);
  }

  /** Oldest first; with `upTo`, only events with an id up to that sequence number. */
  list(room: string, upTo = Infinity): SpectatorEvent[] {
    const all = this.rooms.get(room)?.list() ?? [];
    return upTo === Infinity ? all : all.filter((e) => Number(e.id) <= upTo);
  }

  /** Events newer than `after`, oldest first. */
  since(room: string, after: number): SpectatorEvent[] {
    return (this.rooms.get(room)?.list() ?? []).filter((e) => Number(e.id) > after);
  }
}
