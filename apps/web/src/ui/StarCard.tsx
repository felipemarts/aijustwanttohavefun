import { useEffect, useState } from 'react';
import { type FullProfile, parseFullProfile } from '../data/api';
import { useAgentPos, useLiveVillage } from '../data/store';
import { useT } from '../i18n/store';
import type { Translator } from '../i18n/translator';
import { useDirector, useStarView } from '../map/controller';
import type { Activity } from '../view/activity';
import { titleText } from './AgentCard';
import { GuildBanner, PixelIcon } from './common';
import { useApp } from './context';
import { safeLang } from './LogLine';
import { SpriteFrame } from './SpriteFrame';

/** Profiles of recent stars, so a star who comes back shows at once (refreshed after a minute). */
const cache = new Map<string, { at: number; profile: FullProfile | null }>();

function useStarProfile(name: string | null): FullProfile | null {
  const { source } = useApp();
  const tr = useT();
  const [profile, setProfile] = useState<FullProfile | null>(() => (name ? (cache.get(name)?.profile ?? null) : null));
  useEffect(() => {
    if (!name) return;
    const hit = cache.get(name);
    setProfile(hit?.profile ?? null);
    if (hit && Date.now() - hit.at < 60_000) return;
    let alive = true;
    void source
      .getJson(`/api/public/agents/${encodeURIComponent(name)}?lang=${encodeURIComponent(tr.lang)}`)
      .then((body) => {
        const p = parseFullProfile(body);
        cache.set(name, { at: Date.now(), profile: p });
        if (cache.size > 40) cache.delete(cache.keys().next().value!);
        if (alive) setProfile(p);
      });
    return () => {
      alive = false;
    };
  }, [name, source, tr.lang]);
  return profile;
}

/** Agent words (a say, a wish, a speech): a text node in a quote, with its language, never markup. */
function Quote({ quote, className = '' }: { quote: NonNullable<Activity['quote']>; className?: string }) {
  const lang = safeLang(quote.lang);
  return (
    <q className={`speech ${className}`} lang={lang ?? undefined} dir="auto">
      {quote.text}
    </q>
  );
}

function line(tr: Translator, a: Activity): string {
  return tr.t(`ui.director.now.${a.key}`, a.params);
}

/**
 * The lower-third of director mode, like a sports broadcast: who the star is (portrait, class, level, title, labels,
 * achievements, their bio), what they are doing now, their last actions, and why the director follows them. It
 * belongs to the director: hidden while paused or during a special moment.
 */
export function StarCard() {
  const tr = useT();
  const d = useDirector();
  const view = useStarView();
  const star = d.enabled && d.star && view.star === d.star ? d.star : null;
  const pos = useAgentPos(star);
  const profile = useStarProfile(star);
  const village = useLiveVillage();
  if (!star || !view.now) return null;
  const flags = pos?.f ?? '';
  const cls = pos?.c ?? profile?.cls ?? '';
  const level = pos?.l ?? profile?.level ?? null;
  const title = titleText(tr, pos?.t ?? profile?.title ?? null);
  const hash = pos?.s || profile?.spriteHash || '';
  const party = profile?.party ?? null;
  const partyNames = party ? [party.leader && party.leader !== star ? party.leader : null, ...party.members].filter((n): n is string => !!n && n !== star) : [];
  // The newest achievements first (the list comes in the order they were earned).
  const achs = (profile?.achievements ?? []).slice(-3).reverse();
  const now = view.now;
  return (
    <section className="star-card pixel-box" key={star} aria-live="polite" aria-label={tr.t('ui.director.card.label', { name: star })}>
      <div className="star-portrait" aria-hidden="true">
        {hash ? <SpriteFrame hash={hash} scale={3} /> : null}
      </div>
      <div className="star-body">
        <div className="star-head">
          <span className="star-name">{star}</span>
          {cls ? <span className={`chip chip-class class-${cls}`}>{tr.name('class', cls)}</span> : null}
          {level !== null ? <span className="chip">{tr.t('ui.agent.level', { level })}</span> : null}
          {title ? <span className="star-title">{title}</span> : null}
          {view.why ? <span className="star-why">{tr.t(`ui.director.why.${view.why}`)}</span> : null}
        </div>
        <div className="star-labels">
          {profile?.guild ? (
            <span className="chip star-guild">
              <GuildBanner colors={profile.guild.colors} size={14} />
              <q dir="auto">{profile.guild.name}</q>
            </span>
          ) : null}
          {village.civic.mayor === star ? <span className="chip chip-gold">{tr.t('ui.director.label.mayor')}</span> : null}
          {flags.includes('w') || profile?.reputation?.wanted ? <span className="chip chip-danger">{tr.t('ui.agent.wanted')}</span> : null}
          {party ? (
            <span className="chip chip-safe">
              {partyNames.length
                ? tr.t('ui.director.label.party_with', { names: partyNames.slice(0, 2).join(', ') })
                : tr.t('ui.director.label.party', { n: party.n })}
            </span>
          ) : null}
          {flags.includes('d') ? <span className="chip chip-danger">{tr.t('ui.agent.fallen')}</span> : null}
          {profile?.bot || flags.includes('b') ? <span className="chip">{tr.t('ui.director.label.bot')}</span> : null}
          {achs.map((a) => (
            <span key={a} className="chip chip-ach">
              <PixelIcon icon="star" tone="gold" size={11} />
              {tr.name('ach', a)}
            </span>
          ))}
        </div>
        <div className={`star-now tone-${now.tone}`} key={`${now.key}|${now.ts}`}>
          <PixelIcon icon={now.icon} tone={now.tone} size={20} />
          <span className="star-now-text">{line(tr, now)}</span>
          {now.quote ? <Quote quote={now.quote} className="star-now-quote" /> : null}
        </div>
        {view.recent.length ? (
          <ol className="star-recent" aria-label={tr.t('ui.director.card.recent')}>
            {view.recent.map((a, i) => (
              <li key={`${a.key}|${a.ts}`} style={{ opacity: 0.85 - i * 0.22 }}>
                <PixelIcon icon={a.icon} tone={a.tone} size={12} />
                {line(tr, a)}
              </li>
            ))}
          </ol>
        ) : null}
        {profile?.bio ? (
          <p className="star-bio">
            <Quote quote={{ text: profile.bio.text, lang: profile.bio.lang }} />
          </p>
        ) : null}
      </div>
    </section>
  );
}
