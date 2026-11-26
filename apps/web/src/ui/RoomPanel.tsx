import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { store, useRoomExtras, useRoomLog } from '../data/store';
import { useT } from '../i18n/store';
import { controller } from '../map/controller';
import { useApp } from './context';
import { isLoggable, LogLine } from './LogLine';
import { Panel } from './Panel';

function useAgentsIn(roomId: string): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const count = () => {
      let c = 0;
      for (const a of store.state.agents.values()) if (a.r === roomId) c++;
      setN(c);
    };
    count();
    const id = setInterval(count, 1000);
    return () => clearInterval(id);
  }, [roomId]);
  return n;
}

/** Room panel: the bridge between the text world and the map. Live, localized log of the room. */
export function RoomPanel({ roomId }: { roomId: string }) {
  const tr = useT();
  const { world } = useApp();
  const log = useRoomLog(roomId);
  const extras = useRoomExtras(roomId);
  const agentsHere = useAgentsIn(roomId);
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const st = world.rooms.find((r) => r.id === roomId);
  const live = store.state.rooms.get(roomId);
  const zone = live?.zone ?? st?.zone ?? '';
  const law = world.zones[zone]?.law ?? 'safe';
  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(tr.lang, { hour: '2-digit', minute: '2-digit' }),
    [tr.lang],
  );
  const lines = log.filter(isLoggable).slice(-120);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, roomId]);

  const monsters =
    extras?.monsters.filter((m) => m.n > 0) ?? st?.monsters.map((m) => ({ id: m.id, n: m.n })) ?? [];
  const npcs = extras?.npcs ?? st?.npcs ?? [];

  return (
    <Panel
      title={tr.name('room', roomId)}
      onClose={() => controller.closePanel()}
      kicker={
        <>
          <span className="chip">{tr.name('zone', zone)}</span>
          {st?.level ? <span className="chip">{tr.t('ui.room.level', { level: st.level })}</span> : null}
          <span
            className={`chip ${law === 'lawless' ? 'chip-danger' : law === 'group' ? 'chip-gold' : 'chip-safe'}`}
          >
            {tr.t(`ui.room.law.${law}`)}
          </span>
        </>
      }
    >
      <p className="room-desc">{tr.maybe(`content.room.${roomId}.desc`) ?? ''}</p>
      <div className="room-facts">
        <span>{tr.t('ui.room.agents', { n: agentsHere })}</span>
        {monsters.length ? (
          <span>
            {tr.t('ui.room.monsters')}: {monsters.map((m) => `${tr.name('mon', m.id)} ×${m.n}`).join(', ')}
          </span>
        ) : null}
        {npcs.length ? (
          <span>
            {tr.t('ui.room.npcs')}: {npcs.map((n) => tr.name('npc', n)).join(', ')}
          </span>
        ) : null}
        <button type="button" className="link-btn" onClick={() => controller.commands?.focusRoom(roomId)}>
          {tr.t('ui.room.focus')}
        </button>
      </div>
      <h3 className="heading heading-sm">
        <span className="live-dot is-live" aria-hidden="true" /> {tr.t('ui.room.log')}
      </h3>
      <ol
        className="log"
        ref={listRef}
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {lines.length === 0 ? <li className="log-empty">{tr.t('ui.room.empty')}</li> : null}
        {lines.map((ev) => (
          <LogLine
            key={ev.id}
            ev={ev}
            tr={tr}
            time={ev.ts ? timeFmt.format(ev.ts) : ''}
            onAgent={(n) => controller.openAgent(n)}
          />
        ))}
      </ol>
    </Panel>
  );
}
