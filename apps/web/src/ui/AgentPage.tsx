import { Link, useParams } from 'react-router-dom';
import { useAgentPos } from '../data/store';
import { useT } from '../i18n/store';
import { titleText, useProfile } from './AgentCard';
import { SpriteFrame } from './SpriteFrame';

/** `/a/:name`: a simple public card for now; the full profile comes with milestone M7. */
export function AgentPage() {
  const tr = useT();
  const { name = '' } = useParams();
  const { profile, loading } = useProfile(name);
  const live = useAgentPos(name);
  const hash = live?.s || profile?.spriteHash || '';
  const title = titleText(tr, live?.t ?? profile?.title ?? null);
  const room = live?.r ?? profile?.room ?? null;

  return (
    <div className="page">
      <article className="card pixel-box">
        {loading && !profile ? <p className="muted">{tr.t('ui.common.loading')}</p> : null}
        {!loading && !profile ? (
          <>
            <h1 className="heading">{name}</h1>
            <p>{tr.t('ui.agent.not_found')}</p>
          </>
        ) : null}
        {profile ? (
          <>
            <div className="agent-hero">
              <div className="sprite-stage sprite-stage-lg">
                {hash ? <SpriteFrame hash={hash} scale={6} /> : null}
              </div>
              <div className="agent-meta">
                <h1 className="heading">{profile.name}</h1>
                {title ? <p className="agent-title">{title}</p> : null}
                <p>
                  <span className={`chip chip-class class-${profile.cls}`}>
                    {tr.name('class', profile.cls)}
                  </span>{' '}
                  <span className="chip">{tr.t('ui.agent.level', { level: live?.l ?? profile.level })}</span>{' '}
                  {profile.bot ? <span className="chip">{tr.t('ui.agent.bot')}</span> : null}
                </p>
                {room ? <p className="muted">{tr.t('ui.agent.in_room', { room: `@room:${room}` })}</p> : null}
                <p className="muted small">{tr.t('ui.agent.achievements', { n: profile.achievements })}</p>
              </div>
            </div>
            {profile.look ? (
              <>
                <h2 className="heading heading-sm">{tr.t('ui.agent.look')}</h2>
                <p className="agent-look">{profile.look}</p>
              </>
            ) : null}
            {profile.bio ? (
              <>
                <h2 className="heading heading-sm">{tr.t('ui.agent.bio')}</h2>
                <blockquote className="agent-bio" dir="auto">
                  {profile.bio}
                </blockquote>
              </>
            ) : null}
            <p className="muted small">{tr.t('ui.agent.profile_soon')}</p>
          </>
        ) : null}
        <Link className="btn btn-link" to="/">
          {tr.t('ui.agent.back')}
        </Link>
      </article>
    </div>
  );
}
