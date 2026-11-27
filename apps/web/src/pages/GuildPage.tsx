/** `/g/:name`: a guild's banner, motto, members with their roles, hall and recent highlights. */
import { Link, useParams } from 'react-router-dom';
import { type GuildPublic, parseGuild } from '../data/api';
import { useT } from '../i18n/store';
import { AgentLink, AgentWords, type ApiState, EmptyState, GuildBanner, Loading, PageShell, PixelIcon, RelTime, useApi, useNow } from '../ui/common';
import { fmtInt } from '../view/format';
import { HighlightCard } from './HighlightsPage';

export default function GuildPage() {
  const { name = '' } = useParams();
  const state = useApi(`/api/public/guilds/${encodeURIComponent(name)}`, parseGuild, 60_000);
  return <GuildView name={name} state={state} />;
}

export function GuildView({ name, state }: { name: string; state: ApiState<GuildPublic> }) {
  const tr = useT();
  const now = useNow(60_000);
  if (state.status !== 'ready')
    return (
      <PageShell title={name} kicker={tr.t('ui.guild.kicker')}>
        {state.status === 'loading' ? (
          <Loading />
        ) : (
          <EmptyState icon="banner" title={tr.t('ui.guild.not_found')}>
            <Link className="btn btn-primary" to="/highlights">
              {tr.t('ui.highlights.all')}
            </Link>
          </EmptyState>
        )}
      </PageShell>
    );
  const g = state.data;
  const officers = new Set(g.officers);
  const members = [g.leader, ...g.officers.filter((o) => o !== g.leader), ...g.members.filter((m) => m !== g.leader && !officers.has(m))];
  const role = (n: string) => (n === g.leader ? 'leader' : officers.has(n) ? 'officer' : 'member');
  return (
    <PageShell title={g.name} kicker={tr.t('ui.guild.kicker')} wide>
      <section className="guild-hero pixel-box" style={{ ['--g1' as string]: g.colors[0], ['--g2' as string]: g.colors[1] }}>
        <div className="guild-flag">
          <GuildBanner colors={g.colors} size={120} />
        </div>
        <div className="guild-meta">
          {g.motto ? <AgentWords text={g.motto} block className="guild-motto" /> : <p className="muted">{tr.t('ui.guild.no_motto')}</p>}
          <dl className="facts">
            <div>
              <dt>{tr.t('ui.guild.members')}</dt>
              <dd className="big-num">{fmtInt(tr.lang, members.length)}</dd>
            </div>
            {g.treasury !== null ? (
              <div>
                <dt>{tr.t('ui.guild.treasury')}</dt>
                <dd className="big-num">{tr.t('ui.common.gold', { n: g.treasury, s: fmtInt(tr.lang, g.treasury) })}</dd>
              </div>
            ) : null}
            {g.createdAt ? (
              <div>
                <dt>{tr.t('ui.guild.founded')}</dt>
                <dd>
                  <RelTime ts={g.createdAt} now={now} />
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      </section>
      <div className="profile-grid">
        <section className="vcard pixel-box">
          <h2 className="heading section-title">
            <PixelIcon icon="banner" tone="teal" /> {tr.t('ui.guild.roster')}
          </h2>
          <ul className="roster">
            {members.map((m) => (
              <li key={m}>
                <AgentLink name={m} />
                <span className={`chip ${role(m) === 'leader' ? 'chip-gold' : role(m) === 'officer' ? 'chip-safe' : ''}`}>
                  {tr.t(`ui.guild.rank.${role(m)}`)}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="vcard pixel-box">
          <h2 className="heading section-title">
            <PixelIcon icon="hammer" tone="teal" /> {tr.t('ui.guild.hall')}
          </h2>
          {g.hall ? (
            <>
              <p>{tr.t('ui.guild.hall_on', { room: `@room:${g.hall.plot}` })}</p>
              <p className="muted small">
                <RelTime ts={g.hall.at} now={now} />
              </p>
              <Link className="btn" to={`/?room=${encodeURIComponent(g.hall.plot)}`}>
                {tr.t('ui.highlights.show_on_map')}
              </Link>
            </>
          ) : (
            <p className="muted">{tr.t('ui.guild.no_hall')}</p>
          )}
        </section>
        <section className="vcard pixel-box span-2">
          <h2 className="heading section-title">
            <PixelIcon icon="star" tone="gold" /> {tr.t('ui.profile.highlights')}
          </h2>
          {g.highlights.length ? (
            <ol className="hl-feed">
              {g.highlights.map((h) => (
                <li key={h.id}>
                  <HighlightCard h={h} now={now} />
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">{tr.t('ui.guild.no_highlights')}</p>
          )}
        </section>
      </div>
    </PageShell>
  );
}
