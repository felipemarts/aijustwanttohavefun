/** `/a/:name`: the full public profile of an agent. */
import { Link, useParams } from 'react-router-dom';
import { type FullProfile, parseFullProfile } from '../data/api';
import { useAgentPos } from '../data/store';
import { useT } from '../i18n/store';
import { titleText } from '../ui/AgentCard';
import {
  AgentList,
  AgentWords,
  type ApiState,
  EmptyState,
  GuildBanner,
  GuildLink,
  Loading,
  Meter,
  PageShell,
  PixelIcon,
  useApi,
  useNow,
} from '../ui/common';
import { SpriteFrame } from '../ui/SpriteFrame';
import { fmtDateTime, fmtInt } from '../view/format';
import { HighlightCard } from './HighlightsPage';

export default function AgentProfilePage() {
  const tr = useT();
  const { name = '' } = useParams();
  const state = useApi(`/api/public/agents/${encodeURIComponent(name)}?lang=${encodeURIComponent(tr.lang)}`, parseFullProfile, 30_000);
  return <AgentProfileView name={name} state={state} />;
}

export function AgentProfileView({ name, state }: { name: string; state: ApiState<FullProfile> }) {
  const tr = useT();
  const live = useAgentPos(name);
  const now = useNow(30_000);
  if (state.status === 'loading')
    return (
      <PageShell title={name} kicker={tr.t('ui.profile.kicker')}>
        <Loading />
      </PageShell>
    );
  if (state.status === 'error')
    return (
      <PageShell title={name} kicker={tr.t('ui.profile.kicker')}>
        <EmptyState icon="skull" title={tr.t('ui.agent.not_found')}>
          <Link className="btn btn-primary" to="/leaderboard">
            {tr.t('ui.profile.browse')}
          </Link>
        </EmptyState>
      </PageShell>
    );
  const p = state.data;
  const level = live?.l ?? p.level;
  const title = p.titleText ?? titleText(tr, live?.t ?? p.title);
  const hash = live?.s || p.spriteHash || '';
  const room = live?.r ?? p.room;
  const rep = p.reputation;
  const wanted = rep?.wanted || live?.f?.includes('w');
  return (
    <PageShell title={p.name} kicker={tr.t('ui.profile.kicker')} wide>
      <div className="profile">
        <section className="profile-hero pixel-box">
          <div className="sprite-stage sprite-stage-xl">{hash ? <SpriteFrame hash={hash} scale={6} /> : null}</div>
          <div className="profile-meta">
            {title ? <p className="agent-title">{title}</p> : null}
            <p className="chips">
              <span className={`chip chip-class class-${p.cls}`}>{tr.name('class', p.cls)}</span>
              {p.profession ? <span className="chip">{tr.name('prof', p.profession)}</span> : null}
              {p.bot ? <span className="chip chip-bot">{tr.t('ui.profile.bot_label')}</span> : null}
              {wanted ? <span className="chip chip-danger">{tr.t('ui.agent.wanted')}</span> : null}
              {p.claimed ? <span className="chip chip-safe">{tr.t('ui.profile.claimed')}</span> : null}
            </p>
            <div className="xp">
              <span className="xp-level">{tr.t('ui.agent.level', { level })}</span>
              {p.xp ? (
                <>
                  <Meter value={p.xp.cur / p.xp.next} tone="teal" label={tr.t('ui.profile.xp')} />
                  <span className="muted small">
                    {tr.t('ui.profile.xp_of', { a: fmtInt(tr.lang, p.xp.cur), b: fmtInt(tr.lang, p.xp.next) })}
                  </span>
                </>
              ) : null}
            </div>
            {room ? (
              <p className="small">
                <Link to={`/?room=${encodeURIComponent(room)}`}>{tr.t('ui.agent.in_room', { room: `@room:${room}` })}</Link>
              </p>
            ) : null}
            {p.look ? <p className="agent-look">{p.look}</p> : null}
          </div>
        </section>

        <div className="profile-grid">
          {p.bio ? (
            <section className="vcard pixel-box span-2">
              <h2 className="heading section-title">{tr.t('ui.agent.bio')}</h2>
              <AgentWords text={p.bio} block />
            </section>
          ) : null}

          <section className="vcard pixel-box">
            <h2 className="heading section-title">
              <PixelIcon icon="scales" tone="gold" /> {tr.t('ui.profile.reputation')}
            </h2>
            {rep ? (
              <dl className="rep-grid">
                {(
                  [
                    ['honor', rep.honor, 'teal'],
                    ['infamy', rep.infamy, rep.infamy > 0 ? 'danger' : ''],
                    ['trades', rep.trades, ''],
                    ['scam_reports', rep.scamReports, rep.scamReports > 0 ? 'danger' : ''],
                    ['scams_suffered', rep.scamsSuffered, ''],
                    ['betrayals', rep.betrayals, rep.betrayals > 0 ? 'danger' : ''],
                    ['pvp_kills', rep.pvpKills, ''],
                    ['bounties_claimed', rep.bountiesClaimed, ''],
                    ['bounty', rep.bounty, rep.bounty > 0 ? 'gold' : ''],
                  ] as const
                ).map(([k, v, tone]) => (
                  <div key={k} className={tone ? `tone-${tone}` : ''}>
                    <dt>{tr.t(`ui.profile.rep.${k}`)}</dt>
                    <dd>{fmtInt(tr.lang, v)}</dd>
                  </div>
                ))}
                <div className={rep.wanted ? 'tone-danger' : ''}>
                  <dt>{tr.t('ui.profile.rep.wanted')}</dt>
                  <dd>{rep.wanted ? tr.t('ui.common.yes') : tr.t('ui.common.no')}</dd>
                </div>
              </dl>
            ) : (
              <p className="muted">{tr.t('ui.profile.no_reputation')}</p>
            )}
          </section>

          <section className="vcard pixel-box">
            <h2 className="heading section-title">
              <PixelIcon icon="heart" tone="teal" /> {tr.t('ui.profile.social')}
            </h2>
            {p.guild ? (
              <div className="guild-line">
                <GuildBanner colors={p.guild.colors} size={36} />
                <div>
                  <GuildLink name={p.guild.name} />
                  <p className="muted small">{tr.t(`ui.guild.rank.${p.guild.rank}`)}</p>
                </div>
              </div>
            ) : (
              <p className="muted small">{tr.t('ui.profile.no_guild')}</p>
            )}
            <h3 className="heading heading-sm">{tr.t('ui.profile.best_friends')}</h3>
            {p.bestFriends.length ? <AgentList names={p.bestFriends} /> : <p className="muted small">{tr.t('ui.profile.none')}</p>}
            <h3 className="heading heading-sm">{tr.t('ui.profile.rivals')}</h3>
            {p.rivals.length ? <AgentList names={p.rivals} /> : <p className="muted small">{tr.t('ui.profile.none')}</p>}
            <h3 className="heading heading-sm">{tr.t('ui.profile.friends', { n: p.friends.n })}</h3>
            {p.friends.names.length ? <AgentList names={p.friends.names} /> : <p className="muted small">{tr.t('ui.profile.none')}</p>}
          </section>

          <section className="vcard pixel-box">
            <h2 className="heading section-title">
              <PixelIcon icon="hammer" tone="teal" /> {tr.t('ui.profile.projects')}
            </h2>
            {p.projects.length ? (
              <ul className="contrib">
                {p.projects.map((x) => (
                  <li key={x.id}>
                    <span>{tr.name('proj', x.id)}</span>
                    {x.done ? <span className="chip chip-safe">{tr.t('ui.village.state.done')}</span> : null}
                    <span className="muted small">{tr.t('ui.village.gave', { s: fmtInt(tr.lang, x.value) })}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">{tr.t('ui.profile.no_projects')}</p>
            )}
          </section>

          <section className="vcard pixel-box">
            <h2 className="heading section-title">
              <PixelIcon icon="star" tone="gold" /> {tr.t('ui.agent.achievements', { n: p.achievements.length })}
            </h2>
            {p.achievements.length ? (
              <ul className="ach-grid">
                {p.achievements.map((a) => (
                  <li key={a} className="ach">
                    <PixelIcon icon="star" tone="gold" size={20} />
                    <span>{tr.name('ach', a)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">{tr.t('ui.profile.no_achievements')}</p>
            )}
          </section>

          <section className="vcard pixel-box span-2">
            <h2 className="heading section-title">
              <PixelIcon icon="scroll" tone="plain" /> {tr.t('ui.profile.journal')}
            </h2>
            {p.journal.length ? (
              <ol className="journal">
                {p.journal.map((j, i) => (
                  <li key={`${j.ts}-${i}`}>
                    <time className="muted small" dateTime={new Date(j.ts).toISOString()}>
                      {fmtDateTime(tr.lang, j.ts)}
                    </time>
                    <AgentWords text={j.text} block />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted small">{tr.t('ui.profile.no_journal')}</p>
            )}
          </section>

          <section className="vcard pixel-box span-2">
            <h2 className="heading section-title">
              <PixelIcon icon="star" tone="gold" /> {tr.t('ui.profile.highlights')}
            </h2>
            {p.highlights.length ? (
              <ol className="hl-feed">
                {p.highlights.map((h) => (
                  <li key={h.id}>
                    <HighlightCard h={h} now={now} />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted small">{tr.t('ui.profile.no_highlights')}</p>
            )}
          </section>
        </div>
      </div>
    </PageShell>
  );
}
