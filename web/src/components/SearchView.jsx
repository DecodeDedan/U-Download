import { formatTime } from "../lib/time";
import { IconDownload } from "./icons";

const compactNumber = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** Stacher-style search results: one tap to queue any of them. */
export default function SearchView({ state, source, onSource, onDownload, onRetry }) {
  return (
    <section className="search" aria-labelledby="search-heading">
      <header className="tasks__head">
        <h2 id="search-heading" className="section-title">Search</h2>
        <div className="segmented" role="radiogroup" aria-label="Search on">
          {[["youtube", "YouTube"], ["soundcloud", "SoundCloud"]].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={source === id}
              className="segmented__opt"
              onClick={() => onSource(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {state.status === "idle" && (
        <div className="empty">
          <p className="empty__title">Search without leaving the app</p>
          <p className="empty__hint">Type words in the bar above and press Search.</p>
        </div>
      )}
      {state.status === "loading" && (
        <ul className="results" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="result result--loading">
              <div className="result__thumb skeleton" />
              <div className="preview__lines">
                <span className="skeleton skeleton--line" />
                <span className="skeleton skeleton--line skeleton--short" />
              </div>
            </li>
          ))}
        </ul>
      )}
      {state.status === "error" && (
        <div className="empty" role="alert">
          <p className="empty__title">The search did not go through</p>
          <p className="empty__hint">{state.error}</p>
          <button type="button" className="btn btn-sm btn-secondary" onClick={onRetry}>Try again</button>
        </div>
      )}
      {state.status === "done" && state.hits.length === 0 && (
        <div className="empty">
          <p className="empty__title">No results for “{state.query}”</p>
          <p className="empty__hint">Try fewer or different words.</p>
        </div>
      )}
      {state.status === "done" && state.hits.length > 0 && (
        // Its own scroll area, so the results scroll under the search bar
        // and the core instead of pushing them off screen. Focusable so the
        // keyboard can scroll it too.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <ul className="results results--scroll" tabIndex={0} aria-label={`${state.hits.length} results for ${state.query}`}>
          {state.hits.map((hit) => (
            <li key={hit.url} className="result">
              {hit.thumbnail ? (
                <img className="result__thumb" src={hit.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
              ) : (
                <div className="result__thumb preview__thumb--blank" aria-hidden="true" />
              )}
              <div className="preview__lines">
                <p className="preview__title">{hit.title || hit.url}</p>
                <p className="preview__meta">
                  {[
                    hit.uploader,
                    hit.duration ? formatTime(hit.duration) : null,
                    hit.views ? `${compactNumber.format(hit.views)} views` : null,
                  ].filter(Boolean).join(" · ")}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => onDownload(hit)}
                aria-label={`Download ${hit.title}`}
              >
                <IconDownload size={16} />
                <span>Get</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
