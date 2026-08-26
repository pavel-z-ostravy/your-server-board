import VmList from "components/backups/vm-list";
import SyncThemeColor from "components/layout/SyncThemeColor";

import { getSettings } from "utils/config/config";

export async function getStaticProps() {
  const { providers, ...settings } = getSettings();
  return { props: { initialSettings: settings } };
}

export default function BackupsPage({ initialSettings }) {
  return (
    <div className="flex flex-col m-4 sm:m-8 sm:mt-16 mb-2">
      <SyncThemeColor settings={initialSettings} />
      <h1 className="text-theme-800 dark:text-theme-300 text-xl font-medium mb-4">Backups</h1>
      <VmList />
    </div>
  );
}
