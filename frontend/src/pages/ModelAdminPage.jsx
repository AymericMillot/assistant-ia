import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useState } from "react";
import AccessGate from "./AccessGate";
import AttachmentManager from "./admin/AttachmentManager";
import DocumentManager from "./admin/DocumentManager";
import IndexManager from "./admin/IndexManager";
import DataManager from "./admin/DataManager";
import SearchManager from "./admin/SearchManager";
import FeedbackManager from "./admin/FeedbackManager";
import PerformanceManager from "./admin/PerformanceManager";
import AnalyticsManager from "./admin/AnalyticsManager";
import AuditLogManager from "./admin/AuditLogManager";
import AdminUsersManager from "./admin/AdminUsersManager";
import DeploymentManager from "./admin/DeploymentManager";
import ManualResourceManager from "../components/ManualResourceManager";
import SupportManager from "../components/SupportManager";
import UpdateManager from "../components/UpdateManager";
import ModelManager from "./admin/ModelManager";
import BrandingManager from "./admin/BrandingManager";
import { fetchJson } from "../lib/api";

function TabIcon({ name }) {
  const shared = {
    className: "h-4 w-4 shrink-0",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true
  };

  switch (name) {
    case "documents":
      return (
        <svg {...shared}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      );
    case "recherche":
      return (
        <svg {...shared}>
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.35-4.35" />
        </svg>
      );
    case "personnalisation":
      return (
        <svg {...shared}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
        </svg>
      );
    case "feedback":
      return (
        <svg {...shared}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "pieces-jointes":
      return (
        <svg {...shared}>
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      );
    case "modeles":
      return (
        <svg {...shared}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M9 9h6v6H9z" />
          <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
        </svg>
      );
    case "indexation":
      return (
        <svg {...shared}>
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      );
    case "performance":
      return (
        <svg {...shared}>
          <path d="M3 3v18h18" />
          <path d="m7 14 4-4 3 3 5-6" />
        </svg>
      );
    case "donnees":
      return (
        <svg {...shared}>
          <ellipse cx="12" cy="5" rx="8" ry="3" />
          <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
          <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
        </svg>
      );
    case "mise-a-jour":
      return (
        <svg {...shared}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="m7 10 5 5 5-5" />
          <path d="M12 15V3" />
        </svg>
      );
    case "export-deploiement":
      return (
        <svg {...shared}>
          <path d="M4 4h16v16H4z" />
          <path d="M4 9h16" />
          <path d="m9 15 3-3 3 3" />
          <path d="M12 12v6" />
        </svg>
      );
    case "analytics":
      return (
        <svg {...shared}>
          <path d="M3 3v18h18" />
          <rect x="7" y="12" width="3" height="6" />
          <rect x="12" y="8" width="3" height="10" />
          <rect x="17" y="5" width="3" height="13" />
        </svg>
      );
    case "audit":
      return (
        <svg {...shared}>
          <path d="M9 12h6M9 16h6M9 8h6" />
          <path d="M5 3h9l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
        </svg>
      );
    case "comptes-admin":
      return (
        <svg {...shared}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
        </svg>
      );
    default:
      return null;
  }
}

const baseTabs = [
  { id: "documents", label: "Documents" },
  { id: "pieces-jointes", label: "Pièces jointes" },
  { id: "recherche", label: "Recherche" },
  { id: "identite", label: "Identité" },
  { id: "personnalisation", label: "Personnalisation" },
  { id: "feedback", label: "Feedback" },
  { id: "analytics", label: "Analytics" },
  { id: "modeles", label: "Modèles" },
  { id: "indexation", label: "Indexation" },
  { id: "performance", label: "Performance" },
  { id: "donnees", label: "Données" },
  { id: "mise-a-jour", label: "Mise à jour" }
];
const ownerOnlyTabs = [
  { id: "comptes-admin", label: "Comptes admin" },
  { id: "audit", label: "Audit" },
  { id: "export-deploiement", label: "Export et déploiement" }
];

const defaultTabId = "documents";

export default function ModelAdminPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [authRequiredMessage, setAuthRequiredMessage] = useState("");
  const [showReconnect, setShowReconnect] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [userRole, setUserRole] = useState(null);

  const tabs = userRole === "owner" ? [...baseTabs, ...ownerOnlyTabs] : baseTabs;
  const validTabIds = new Set(tabs.map((tab) => tab.id));

  const requestedTab = searchParams.get("tab") || defaultTabId;
  const activeTab = validTabIds.has(requestedTab) ? requestedTab : defaultTabId;

  useEffect(() => {
    let active = true;

    fetchJson("/api/auth/me")
      .then((payload) => {
        if (active) {
          setUserRole(payload?.user?.role || null);
        }
      })
      .catch(() => {
        if (active) {
          setUserRole(null);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  function setActiveTab(tabId) {
    if (tabId === activeTab) {
      return;
    }

    const nextParams = new URLSearchParams(searchParams);
    if (tabId === defaultTabId) {
      nextParams.delete("tab");
    } else {
      nextParams.set("tab", tabId);
    }
    setSearchParams(nextParams);
  }

  useEffect(() => {
    function handleAuthRequired(event) {
      setAuthRequiredMessage(event.detail?.message || "Authentification requise.");
    }

    window.addEventListener("admin-auth-required", handleAuthRequired);
    return () => {
      window.removeEventListener("admin-auth-required", handleAuthRequired);
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function loadUpdateStatus() {
      try {
        const payload = await fetchJson("/api/admin/update/status");
        if (!active) {
          return;
        }

        setUpdateAvailable(Boolean(payload?.updateAvailable));
      } catch {
        if (!active) {
          return;
        }

        setUpdateAvailable(false);
      }
    }

    loadUpdateStatus();
    const interval = window.setInterval(loadUpdateStatus, 30000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  async function logout() {
    await fetchJson("/api/auth/logout", {
      method: "POST"
    });
    navigate("/admin", { replace: true });
    window.location.reload();
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      {showReconnect ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/20 px-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-[32px] border border-white/80 bg-white p-6 shadow-[0_30px_80px_rgba(15,23,42,0.2)] dark:border-slate-700 dark:bg-slate-900">
            <AccessGate
              embedded
              heading="Reconnecter l'administration."
              description="Entrez à nouveau le mot de passe temporaire pour reprendre la session."
              submitLabel="Se reconnecter"
              onCancel={() => setShowReconnect(false)}
              onAuthenticated={() => {
                setShowReconnect(false);
                setAuthRequiredMessage("");
              }}
            />
          </div>
        </div>
      ) : null}

      <section className="panel px-6 py-6 sm:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500 dark:text-slate-400">
              Administration
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.05em] text-slate-950 dark:text-slate-50">
              Documents, personnalisation et modèle
            </h1>
          </div>

          <div className="flex gap-3">
            <button className="ghost-button" onClick={() => navigate("/", { replace: true })}>
              Retour à l&apos;accueil
            </button>
            <button className="soft-button" onClick={logout}>
              Verrouiller
            </button>
          </div>
        </div>
      </section>

      {authRequiredMessage ? (
        <section className="subpanel px-5 py-4 sm:px-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-slate-600 dark:text-slate-300">{authRequiredMessage}</p>
            <button className="soft-button" onClick={() => setShowReconnect(true)} type="button">
              Se reconnecter
            </button>
          </div>
        </section>
      ) : null}

      <section className="subpanel p-3">
        <div
          className="flex gap-2 overflow-x-auto pb-1 md:flex-wrap md:overflow-visible md:pb-0"
          role="tablist"
          aria-label="Sections de l'administration"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`${activeTab === tab.id ? "soft-button" : "ghost-button"} whitespace-nowrap`}
              onClick={() => setActiveTab(tab.id)}
              role="tab"
              aria-selected={activeTab === tab.id}
              type="button"
            >
              <span className="inline-flex items-center gap-2">
                <TabIcon name={tab.id} />
                <span>{tab.label}</span>
                {tab.id === "mise-a-jour" && updateAvailable ? (
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[11px] font-bold leading-none text-white">
                    1
                  </span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      </section>

      {activeTab === "documents" && <DocumentManager onRefreshSummary={() => {}} />}
      {activeTab === "pieces-jointes" && <AttachmentManager />}
      {activeTab === "recherche" && <SearchManager />}
      {activeTab === "identite" && <BrandingManager />}
      {activeTab === "personnalisation" && <ManualResourceManager />}
      {activeTab === "feedback" && <FeedbackManager />}
      {activeTab === "analytics" && <AnalyticsManager />}
      {activeTab === "modeles" && <ModelManager onRefreshSummary={() => {}} />}
      {activeTab === "indexation" && <IndexManager onRefreshSummary={() => {}} />}
      {activeTab === "performance" && <PerformanceManager />}
      {activeTab === "donnees" && <DataManager />}
      {activeTab === "mise-a-jour" && <UpdateManager />}
      {activeTab === "comptes-admin" && userRole === "owner" && <AdminUsersManager />}
      {activeTab === "audit" && userRole === "owner" && <AuditLogManager />}
      {activeTab === "export-deploiement" && userRole === "owner" && <DeploymentManager />}
      <SupportManager />
    </div>
  );
}
