import { useState } from "react";
import { BiTrash } from "react-icons/bi";
import { mutate } from "swr";

export default function WidgetRemoveButton({ serviceName }) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState(false);

  const handleRemove = async () => {
    setRemoving(true);
    setError(false);
    try {
      const res = await fetch("/api/widgets-catalog/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "service", serviceName }),
      });
      if (!res.ok) {
        setRemoving(false);
        setError(true);
        return;
      }
      await mutate("/api/services");
      setRemoving(false);
      setConfirming(false);
    } catch {
      setRemoving(false);
      setError(true);
    }
  };

  if (confirming) {
    return (
      <div className="shrink-0 flex items-center gap-1 service-tag service-widget-remove-confirm text-[10px]">
        {error && <span className="text-rose-500/80">Failed</span>}
        <button type="button" onClick={handleRemove} disabled={removing} className="cursor-pointer">
          {removing ? "..." : "Remove?"}
        </button>
        <button type="button" onClick={() => setConfirming(false)} disabled={removing} className="cursor-pointer">
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="shrink-0 flex items-center justify-center cursor-pointer service-tag service-widget-remove"
    >
      <BiTrash size={14} />
      <span className="sr-only">Remove widget</span>
    </button>
  );
}
