import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAgentPos } from '../data/store';
import { useT } from '../i18n/store';
import type { Translator } from '../i18n/translator';
import { controller, useFollow } from '../map/controller';
import { type AgentProfile, parseProfile } from './profile';
import { useApp } from './context';
import { Panel } from './Panel';
import { SpriteFrame } from './SpriteFrame';

export function useProfile(name: string): { profile: AgentProfile | null; loading: boolean } {
  const { source } = useApp();
  const tr = useT();
  const [state, setState] = useState<{ profile: AgentProfile | null; loading: boolean }>({
    profile: null,
    loading: true,
  });
  useEffect(() => {
    let alive = true;
    setState((s) => ({ profile: s.profile, loading: true }));
    void source
      .getJson(`/api/public/agents/${encodeURIComponent(name)}?lang=${encodeURIComponent(tr.lang)}`)
      .then((body) => {
        if (alive) setState({ profile: parseProfile(body), loading: false });
      });
    return () => {
      alive = false;
    };
  }, [name, source, tr.lang]);
  return state;
}

/** A title from the server is either an id or already localized text; show the catalog name when it is an id. */
export function titleText(tr: Translator, title: string | null): string | null {
  if (!title) return null;
  return /^[a-z0-9_]+$/.test(title) && tr.has(`content.title.${title}.name`)
    ? tr.name('title', title)
    : title;
}

export function AgentCard({ name }: { name: string }) {
  const tr = useT();
  const live = useAgentPos(name);
  const follow = useFollow();
  const { profile, loading } = useProfile(name);
  const cls = live?.c ?? profile?.cls ?? '';
  const level = live?.l ?? profile?.level ?? null;
  const title = titleText(tr, live?.t ?? profile?.title ?? null);
  const hash = live?.s || profile?.spriteHash || '';
  const room = live?.r ?? profile?.room ?? null;
  const flags = live?.f ?? '';
  const following = follow === name;

  return (
    <Panel
      title={name}
      onClose={() => controller.closePanel()}
      kicker={
        <>
          {cls ? <span className={`chip chip-class class-${cls}`}>{tr.name('class', cls)}</span> : null}
          {level !== null ? <span className="chip">{tr.t('ui.agent.level', { level })}</span> : null}
          {flags.includes('d') ? <span className="chip chip-danger">{tr.t('ui.agent.fallen')}</span> : null}
          {flags.includes('f') ? <span className="chip chip-danger">{tr.t('ui.agent.fighting')}</span> : null}
          {flags.includes('w') ? <span className="chip chip-gold">{tr.t('ui.agent.wanted')}</span> : null}
          {profile?.bot || flags.includes('b') ? <span className="chip">{tr.t('ui.agent.bot')}</span> : null}
        </>
      }
    >
      <div className="agent-hero">
        <div className="sprite-stage">{hash ? <SpriteFrame hash={hash} scale={4} /> : null}</div>
        <div className="agent-meta">
          {title ? <p className="agent-title">{title}</p> : null}
          {room ? (
            <button type="button" className="link-btn" onClick={() => controller.openRoom(room)}>
              {tr.t('ui.agent.in_room', { room: `@room:${room}` })}
            </button>
          ) : null}
          {profile ? (
            <p className="muted small">{tr.t('ui.agent.achievements', { n: profile.achievements })}</p>
          ) : null}
        </div>
      </div>
      {loading && !profile ? <p className="muted">{tr.t('ui.common.loading')}</p> : null}
      {profile?.look ? (
        <>
          <h3 className="heading heading-sm">{tr.t('ui.agent.look')}</h3>
          <p className="agent-look">{profile.look}</p>
        </>
      ) : null}
      {profile?.bio ? (
        <>
          <h3 className="heading heading-sm">{tr.t('ui.agent.bio')}</h3>
          <blockquote className="agent-bio" dir="auto">
            {profile.bio}
          </blockquote>
        </>
      ) : null}
      <div className="agent-actions">
        <button
          type="button"
          className={`btn ${following ? 'btn-primary' : ''}`}
          aria-pressed={following}
          onClick={() => {
            controller.setFollow(following ? null : name);
            if (!following) controller.commands?.focusAgent(name);
          }}
        >
          {following ? tr.t('ui.agent.following') : tr.t('ui.agent.follow')}
        </button>
        <Link className="btn btn-link" to={`/a/${encodeURIComponent(name)}`}>
          {tr.t('ui.agent.profile')}
        </Link>
      </div>
    </Panel>
  );
}
