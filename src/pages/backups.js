import VmList from "components/backups/vm-list";

export default function BackupsPage() {
  return (
    <div className="flex flex-col m-4 sm:m-8 sm:mt-16 mb-2">
      <h1 className="text-theme-800 dark:text-theme-300 text-xl font-medium mb-4">Backups</h1>
      <VmList />
    </div>
  );
}
