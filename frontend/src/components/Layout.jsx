import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useBranding } from "../hooks/useBranding";

const themeStorageKey = "assistant-ia-theme";

const themeCycle = ["auto", "light", "dark"];
const themeLabels = {
  auto: "Thème automatique (suit le système)",
  light: "Thème clair",
  dark: "Thème sombre"
};

// Preference : "auto" (suit le systeme, par defaut), "light" ou "dark".
function getInitialThemePreference() {
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    if (themeCycle.includes(stored)) {
      return stored;
    }
  } catch {
    // Stockage local indisponible (navigation privée) : on suit la préférence système.
  }

  return "auto";
}

function systemPrefersDark() {
  return Boolean(window.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
}

export default function Layout({ children }) {
  const branding = useBranding();
  const [version, setVersion] = useState("1.000");
  const [themePreference, setThemePreference] = useState(getInitialThemePreference);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const theme = themePreference === "auto" ? (systemDark ? "dark" : "light") : themePreference;

  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then((payload) => {
        if (payload.version) {
          setVersion(payload.version);
        }
      })
      .catch(() => {});
  }, []);

  // Onglet du navigateur : titre et favicon reconfigurables par instance
  // (administration > Identite), pour ne pas rester colle a un client
  // particulier sur ce projet generique.
  useEffect(() => {
    document.title = branding.tabTitle || branding.projectName || "Assistant local";
  }, [branding.tabTitle, branding.projectName]);

  useEffect(() => {
    if (!branding.faviconDataUrl) {
      return;
    }
    let link = document.querySelector("link[rel~='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = branding.faviconDataUrl;
  }, [branding.faviconDataUrl]);

  // En mode automatique, le thème suit en direct le réglage du système.
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) {
      return undefined;
    }

    const handleChange = (event) => setSystemDark(event.matches);
    media.addEventListener?.("change", handleChange);
    return () => media.removeEventListener?.("change", handleChange);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    try {
      window.localStorage.setItem(themeStorageKey, themePreference);
    } catch {
      // Ignoré : le thème restera valable pour la session en cours.
    }
  }, [themePreference]);

  function cycleTheme() {
    setThemePreference((current) => themeCycle[(themeCycle.indexOf(current) + 1) % themeCycle.length]);
  }

  return (
    <div className="app-shell">
      <div className="page-container gap-6">
        <header className="flex items-center justify-between px-1 py-2 print:hidden">
          <div className="flex items-center gap-3">
            <div className="h-2.5 w-2.5 rounded-full bg-slate-900 dark:bg-slate-100" />
            <div>
              <p className="text-sm font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-100">
                {branding.projectName}
              </p>
            </div>
          </div>

          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white/80 text-slate-600 transition hover:border-slate-300 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:text-slate-100"
            onClick={cycleTheme}
            aria-label={`${themeLabels[themePreference]} — cliquer pour changer`}
            title={themeLabels[themePreference]}
          >
            {themePreference === "auto" ? (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="8" />
                <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" />
              </svg>
            ) : theme === "light" ? (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </svg>
            ) : (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
        </header>

        {children}

        <footer className="flex flex-col items-center gap-3 px-1 pt-2 print:hidden text-center text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400 sm:flex-row sm:justify-between sm:text-left dark:text-slate-500">
          <span>Version {version}</span>
          <span>
            Créé et entretenu par{" "}
            <a
              href="https://aymericmillot.com"
              target="_blank"
              rel="noreferrer"
              className="text-slate-400 transition hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
            >
              Aymeric Millot
            </a>
          </span>
          <Link
            to="/release"
            className="text-slate-400 transition hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
          >
            Notes de mise à jour
          </Link>
        </footer>
      </div>
    </div>
  );
}
