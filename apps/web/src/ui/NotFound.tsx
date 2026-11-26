import { Link } from 'react-router-dom';
import { useT } from '../i18n/store';

export function NotFound() {
  const tr = useT();
  return (
    <div className="page">
      <article className="card pixel-box">
        <h1 className="heading">{tr.t('ui.notfound.title')}</h1>
        <p>{tr.t('ui.notfound.body')}</p>
        <Link className="btn btn-primary" to="/">
          {tr.t('ui.notfound.home')}
        </Link>
      </article>
    </div>
  );
}
