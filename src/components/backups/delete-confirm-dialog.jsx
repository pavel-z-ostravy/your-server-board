import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { useEffect, useState } from "react";

export default function DeleteConfirmDialog({ open, vmName, onConfirm, onClose }) {
  const [typedName, setTypedName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setTypedName("");
      setDeleting(false);
      setError(null);
    }
  }, [open]);

  const matches = typedName === vmName;

  const handleClose = () => {
    if (!deleting) onClose();
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    const result = await onConfirm();
    setDeleting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-black/50" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-sm rounded-md bg-theme-100 dark:bg-theme-800 p-4 space-y-3">
          <DialogTitle className="text-sm font-bold">Delete backup?</DialogTitle>
          <p className="text-xs">
            This permanently deletes a backup of <strong>{vmName}</strong>. Type the VM/CT name to confirm:
          </p>
          <input
            type="text"
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            placeholder={vmName}
            className="w-full rounded-sm border border-theme-300 dark:border-theme-700 bg-transparent px-2 py-1 text-xs"
          />
          {error && <p className="text-xs text-rose-500/80">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={handleClose} disabled={deleting} className="text-xs px-2 py-1">
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={!matches || deleting}
              className="text-xs px-2 py-1 text-rose-500/80 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {deleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
