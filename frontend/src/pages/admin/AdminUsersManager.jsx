import { useEffect, useState } from "react";
import { fetchJson, formatDateTime } from "../../lib/api";
import { reportError } from "../../lib/errors";
import Alert from "../../components/ui/Alert";
import EmptyState from "../../components/ui/EmptyState";
import StatusBadge from "../../components/ui/StatusBadge";

const roleLabels = {
  owner: "Propriétaire",
  teacher: "Enseignant"
};

function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export default function AdminUsersManager() {
  const [users, setUsers] = useState([]);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [identifiant, setIdentifiant] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("teacher");
  const [creating, setCreating] = useState(false);

  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);
  const [resettingId, setResettingId] = useState(null);
  const [resetPasswordValue, setResetPasswordValue] = useState("");

  async function loadUsers() {
    setLoading(true);
    setError("");

    try {
      const payload = await fetchJson("/api/admin/admin-users");
      setUsers(payload.users || []);
    } catch (requestError) {
      setError(reportError("admin-users", requestError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
    fetchJson("/api/auth/me")
      .then((payload) => setCurrentUserId(payload?.user?.adminUserId ?? null))
      .catch(() => setCurrentUserId(null));
  }, []);

  async function handleCreate(event) {
    event.preventDefault();
    if (creating) {
      return;
    }

    setCreating(true);
    setError("");
    setSuccess("");

    try {
      await fetchJson("/api/admin/admin-users", {
        method: "POST",
        body: JSON.stringify({ identifiant, password, role })
      });
      setSuccess(`Compte "${identifiant}" créé.`);
      setIdentifiant("");
      setPassword("");
      setRole("teacher");
      await loadUsers();
    } catch (requestError) {
      setError(reportError("admin-users-create", requestError));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(user) {
    if (confirmingDeleteId !== user.id) {
      setConfirmingDeleteId(user.id);
      return;
    }

    setError("");
    setSuccess("");

    try {
      await fetchJson(`/api/admin/admin-users/${user.id}`, { method: "DELETE" });
      setSuccess(`Compte "${user.identifier}" supprimé.`);
      setConfirmingDeleteId(null);
      await loadUsers();
    } catch (requestError) {
      setError(reportError("admin-users-delete", requestError));
    }
  }

  async function handleRoleChange(user, nextRole) {
    if (nextRole === user.role) {
      return;
    }

    setError("");
    setSuccess("");

    try {
      await fetchJson(`/api/admin/admin-users/${user.id}/role`, {
        method: "PUT",
        body: JSON.stringify({ role: nextRole })
      });
      setSuccess(`Rôle de "${user.identifier}" mis à jour.`);
      await loadUsers();
    } catch (requestError) {
      setError(reportError("admin-users-role", requestError));
    }
  }

  async function handleResetPassword(user) {
    if (resettingId !== user.id) {
      setResettingId(user.id);
      setResetPasswordValue(generatePassword());
      return;
    }

    setError("");
    setSuccess("");

    try {
      await fetchJson(`/api/admin/admin-users/${user.id}/password`, {
        method: "PUT",
        body: JSON.stringify({ password: resetPasswordValue })
      });
      setSuccess(`Mot de passe de "${user.identifier}" mis à jour : ${resetPasswordValue}`);
      setResettingId(null);
      setResetPasswordValue("");
    } catch (requestError) {
      setError(reportError("admin-users-reset", requestError));
    }
  }

  return (
    <div className="space-y-6">
      <section className="panel px-6 py-6 sm:px-8">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500 dark:text-slate-400">
          Réservé au propriétaire
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-slate-50">
          Comptes admin
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
          Créez des accès administrateur nommés (identifiant + mot de passe propres à chaque
          personne), en plus des mots de passe partagés (propriétaire, enseignant, rotatif).
        </p>
      </section>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {success ? <Alert tone="success">{success}</Alert> : null}

      <section className="subpanel p-6">
        <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Nouveau compte</h3>
        <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={handleCreate}>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
            Identifiant
            <input
              type="text"
              className="input mt-2"
              value={identifiant}
              onChange={(event) => setIdentifiant(event.target.value)}
              placeholder="ex : marie.dupont"
              autoComplete="off"
              required
            />
          </label>

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
            Rôle
            <select className="input mt-2" value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="teacher">Enseignant</option>
              <option value="owner">Propriétaire</option>
            </select>
          </label>

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 sm:col-span-2">
            Mot de passe (au moins 8 caractères)
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                className="input flex-1"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Mot de passe"
                autoComplete="new-password"
                required
                minLength={8}
              />
              <button
                type="button"
                className="ghost-button whitespace-nowrap"
                onClick={() => setPassword(generatePassword())}
              >
                Générer
              </button>
            </div>
          </label>

          <div className="sm:col-span-2">
            <button className="soft-button" disabled={creating}>
              {creating ? "Création..." : "Créer le compte"}
            </button>
          </div>
        </form>
      </section>

      <section className="subpanel p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
            {users.length} compte(s)
          </h3>
          <button className="ghost-button" onClick={loadUsers} disabled={loading}>
            {loading ? "Chargement..." : "Actualiser"}
          </button>
        </div>

        <div className="mt-4 space-y-2">
          {!loading && users.length === 0 ? (
            <EmptyState title="Aucun compte admin nommé pour le moment." />
          ) : (
            users.map((user) => (
              <article
                key={user.id}
                className="flex flex-col gap-3 rounded-[18px] border border-slate-200 bg-slate-50/60 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-700 dark:bg-slate-800/50"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {user.identifier}
                    </span>
                    <StatusBadge tone={user.role === "owner" ? "info" : "success"}>
                      {roleLabels[user.role] || user.role}
                    </StatusBadge>
                    {user.id === currentUserId ? (
                      <StatusBadge tone="neutral">Vous</StatusBadge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Créé le {formatDateTime(user.createdAt)}
                  </p>
                  {resettingId === user.id ? (
                    <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                      Nouveau mot de passe :{" "}
                      <code className="rounded bg-slate-200 px-1.5 py-0.5 dark:bg-slate-700">
                        {resetPasswordValue}
                      </code>{" "}
                      — cliquez à nouveau sur "Réinitialiser" pour confirmer.
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <select
                    className="input px-2 py-1.5 text-xs"
                    value={user.role}
                    onChange={(event) => handleRoleChange(user, event.target.value)}
                  >
                    <option value="teacher">Enseignant</option>
                    <option value="owner">Propriétaire</option>
                  </select>
                  <button
                    className="ghost-button px-3 py-1.5 text-xs"
                    type="button"
                    onClick={() => handleResetPassword(user)}
                  >
                    {resettingId === user.id ? "Confirmer" : "Réinitialiser"}
                  </button>
                  <button
                    className="ghost-button px-3 py-1.5 text-xs text-rose-600 dark:text-rose-300"
                    type="button"
                    disabled={user.id === currentUserId}
                    onClick={() => handleDelete(user)}
                  >
                    {confirmingDeleteId === user.id ? "Confirmer ?" : "Supprimer"}
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
