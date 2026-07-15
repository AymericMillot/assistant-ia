import { useState } from "react";
import { useBranding } from "../hooks/useBranding";

export default function SupportManager() {
  const [open, setOpen] = useState(false);
  const branding = useBranding();

  return (
    <section className="subpanel px-5 py-4 sm:px-6">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-3xl">
            <p className="text-sm font-medium text-slate-700">Contact assistance</p>
            <p className="mt-1 text-sm text-slate-500">
              Pour tout renseignement, signalement de bug ou suggestion.
            </p>
          </div>

          <button
            className="ghost-button gap-2"
            onClick={() => setOpen((current) => !current)}
            type="button"
          >
            <span>{open ? "Masquer" : "Afficher"}</span>
            <svg
              viewBox="0 0 20 20"
              fill="none"
              className={`h-4 w-4 transition ${open ? "rotate-180" : ""}`}
              aria-hidden="true"
            >
              <path
                d="M5 7.5L10 12.5L15 7.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        {open ? (
          <div className="border-t border-slate-200/70 pt-4">
            <article className="rounded-3xl border border-slate-200 bg-white px-5 py-4 text-sm text-slate-600">
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-400">
                Contact e-mail
              </p>
              {branding.supportEmail || branding.supportEmailUrgent ? (
                <div className="mt-3 space-y-2">
                  {branding.supportEmail ? (
                    <div>
                      <p className="text-xs text-slate-400">Service informatique</p>
                      <a
                        className="inline-flex text-base font-semibold text-slate-900 underline decoration-slate-300 underline-offset-4 transition hover:decoration-slate-700"
                        href={`mailto:${branding.supportEmail}`}
                      >
                        {branding.supportEmail}
                      </a>
                    </div>
                  ) : null}
                  {branding.supportEmailUrgent ? (
                    <div>
                      <p className="text-xs text-slate-400">Soucis majeur</p>
                      <a
                        className="inline-flex text-base font-semibold text-slate-900 underline decoration-slate-300 underline-offset-4 transition hover:decoration-slate-700"
                        href={`mailto:${branding.supportEmailUrgent}`}
                      >
                        {branding.supportEmailUrgent}
                      </a>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="mt-3 text-sm text-slate-500">
                  Aucune adresse de contact n&apos;est configurée pour le moment.
                </p>
              )}
              <p className="mt-2 text-sm text-slate-500">
                Pour tout renseignement, signalement de bug ou suggestion.
              </p>
            </article>
          </div>
        ) : null}
      </div>
    </section>
  );
}
