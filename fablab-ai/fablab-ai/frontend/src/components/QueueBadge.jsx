import { formatDuration } from "../lib/api";

function ordinal(position) {
  if (!position) {
    return "";
  }

  if (position === 1) {
    return "1re";
  }

  return `${position}e`;
}

export default function QueueBadge({ status }) {
  if (!status) {
    return null;
  }

  if (!status.position && !status.totalInQueue) {
    return (
      <div className="status-pill border-emerald-200 bg-emerald-50 text-emerald-700">
        Assistant disponible immédiatement
      </div>
    );
  }

  if (status.isProcessing && status.position === 1) {
    return (
      <div className="status-pill border-brand/20 bg-accent text-brand">
        Votre question est en cours de traitement.
      </div>
    );
  }

  if (status.position) {
    return (
      <div className="status-pill border-amber-200 bg-amber-50 text-amber-700">
        Vous êtes {ordinal(status.position)} dans la file d&apos;attente, environ{" "}
        {formatDuration(status.estimatedWaitSeconds)}
      </div>
    );
  }

  return (
    <div className="status-pill border-slate-200 bg-slate-50 text-slate-600">
      {status.totalInQueue} requête{status.totalInQueue > 1 ? "s" : ""} dans la file d&apos;attente
    </div>
  );
}
