import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import AccessGate from "./pages/AccessGate";
import ModelAdminPage from "./pages/ModelAdminPage";
import ReleaseNotesPage from "./pages/ReleaseNotesPage";
import UserChat from "./pages/UserChat";
import { fetchJson } from "./lib/api";
import { reportError } from "./lib/errors";

function ForceTeacherPasswordChange({ onChanged }) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");

    if (newPassword.length < 12) {
      setError("Le mot de passe doit contenir au moins 12 caractères.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("Les deux mots de passe ne correspondent pas.");
      return;
    }

    setSaving(true);
    try {
      await fetchJson("/api/auth/teacher-password/self", {
        method: "PUT",
        body: JSON.stringify({ newPassword })
      });
      onChanged();
    } catch (requestError) {
      setError(reportError("force-password-change", requestError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mx-auto flex min-h-[78vh] w-full max-w-md items-center">
      <div className="panel w-full px-6 py-7 sm:px-8 sm:py-9">
        <div className="rounded-[32px] border border-white/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(247,249,252,0.92))] p-6 shadow-soft">
          <h1 className="text-3xl font-semibold tracking-[-0.05em] text-slate-950">
            Changement de mot de passe requis.
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-500">
            Ce mot de passe a été généré automatiquement. Choisissez-en un nouveau avant de
            continuer.
          </p>
        </div>

        <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
          <label className="block text-sm font-medium text-slate-700">
            Nouveau mot de passe
            <input
              type="password"
              className="input mt-2"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              autoFocus
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Confirmation
            <input
              type="password"
              className="input mt-2"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
            />
          </label>

          {error && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          )}

          <button className="soft-button w-full justify-center" disabled={saving}>
            {saving ? "Mise à jour..." : "Valider le nouveau mot de passe"}
          </button>
        </form>
      </div>
    </section>
  );
}

function AppGate({ children }) {
  const [state, setState] = useState({
    loading: true,
    authenticated: false,
    mustChangePassword: false
  });

  function checkSession() {
    fetchJson("/api/auth/me")
      .then((payload) => {
        setState({
          loading: false,
          authenticated: true,
          mustChangePassword: Boolean(payload?.mustChangePassword)
        });
      })
      .catch(() => {
        setState({
          loading: false,
          authenticated: false,
          mustChangePassword: false
        });
      });
  }

  useEffect(() => {
    checkSession();
  }, []);

  if (state.loading) {
    return (
      <div className="panel px-6 py-8 text-center text-sm text-slate-500">
        Verification de la session...
      </div>
    );
  }

  if (!state.authenticated) {
    return <AccessGate onAuthenticated={checkSession} />;
  }

  if (state.mustChangePassword) {
    return <ForceTeacherPasswordChange onChanged={checkSession} />;
  }

  return children;
}

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<UserChat />} />
        <Route path="/release" element={<ReleaseNotesPage />} />
        <Route
          path="/admin"
          element={
            <AppGate>
              <ModelAdminPage />
            </AppGate>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
