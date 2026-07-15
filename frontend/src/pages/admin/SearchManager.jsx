import { useEffect, useState } from "react";
import { fetchJson } from "../../lib/api";
import { reportError } from "../../lib/errors";

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderSnippet(snippet, query) {
  if (!snippet) {
    return null;
  }

  const safeQuery = String(query || "").trim();
  if (!safeQuery) {
    return snippet;
  }

  const pattern = new RegExp(`(${escapeRegExp(safeQuery)})`, "gi");
  const parts = String(snippet).split(pattern);

  return parts.map((part, index) =>
    part.toLowerCase() === safeQuery.toLowerCase() ? (
      <mark
        key={`match-${index}`}
        className="rounded-md bg-amber-100 px-1 text-slate-900"
      >
        {part}
      </mark>
    ) : (
      <span key={`text-${index}`}>{part}</span>
    )
  );
}

export default function SearchManager() {
  const [query, setQuery] = useState("");
  const [folderName, setFolderName] = useState("all");
  const [folders, setFolders] = useState([]);
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchJson("/api/admin/folders")
      .then((payload) => {
        setFolders(payload.folders || []);
      })
      .catch((requestError) => {
        setError(reportError("searchmanager", requestError));
      });
  }, []);

  async function submitSearch(event) {
    event.preventDefault();
    if (!query.trim()) {
      return;
    }

    setLoading(true);
    setError("");

    try {
      const payload = await fetchJson("/api/admin/search/indexed", {
        method: "POST",
        body: JSON.stringify({
          query,
          folderName
        })
      });

      setResults(payload.results || []);
      setTotal(payload.total || 0);
      setSearched(true);
    } catch (requestError) {
      setError(reportError("searchmanager", requestError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="panel px-6 py-6 sm:px-8">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500">
            Recherche
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950">
            Recherche dans les chunks indexés
          </h2>
          <p className="mt-2 text-sm text-slate-500">
            Retrouvez rapidement un mot, une expression ou un passage dans les documents déjà indexés.
          </p>
        </div>
      </section>

      <section className="subpanel px-5 py-5 sm:px-6">
        <form className="space-y-4" onSubmit={submitSearch}>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px_auto]">
            <input
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 outline-none transition focus:border-slate-400"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Mot ou expression à rechercher"
              value={query}
            />

            <select
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 outline-none transition focus:border-slate-400"
              onChange={(event) => setFolderName(event.target.value)}
              value={folderName}
            >
              <option value="all">Tous les dossiers</option>
              {folders.map((folder) => (
                <option key={folder} value={folder}>
                  {folder}
                </option>
              ))}
            </select>

            <button className="soft-button justify-center" disabled={loading || !query.trim()} type="submit">
              {loading ? "Recherche..." : "Rechercher"}
            </button>
          </div>

          {error ? <p className="text-sm text-rose-600">{error}</p> : null}
          {searched && !error ? (
            <p className="text-sm text-slate-500">
              {total} résultat{total > 1 ? "s" : ""} trouvé{total > 1 ? "s" : ""}
            </p>
          ) : null}
        </form>
      </section>

      {searched && results.length === 0 && !loading && !error ? (
        <section className="subpanel px-5 py-8 text-sm text-slate-500 sm:px-6">
          Aucun chunk indexé ne contient cette recherche.
        </section>
      ) : null}

      {results.length > 0 ? (
        <section className="space-y-4">
          {results.map((result) => (
            <article key={`${result.relativePath}-${result.chunkIndex}-${result.id}`} className="subpanel px-5 py-5 sm:px-6">
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="text-base font-semibold text-slate-900">{result.fileName}</h3>
                    <p className="mt-1 text-sm text-slate-500">
                      {result.folder} · chunk {result.chunkIndex} · score {result.score}
                    </p>
                  </div>

                  <span
                    className={`inline-flex w-fit rounded-full border px-3 py-1 text-xs font-medium ${
                      result.visibility === "public"
                        ? "border-sky-200 bg-sky-50 text-sky-700"
                        : "border-slate-200 bg-slate-100 text-slate-700"
                    }`}
                  >
                    {result.visibility === "public" ? "Public" : "Privé"}
                  </span>
                </div>

                <p className="text-[15px] leading-7 text-slate-700">
                  {renderSnippet(result.snippet, query)}
                </p>

                <p className="text-xs text-slate-400">{result.relativePath}</p>
              </div>
            </article>
          ))}
        </section>
      ) : null}
    </div>
  );
}
