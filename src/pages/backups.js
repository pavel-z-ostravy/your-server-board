import ConfigBackup from "components/backups/config-backup";
import VmList from "components/backups/vm-list";
import PageBackground from "components/layout/PageBackground";
import PageHeader from "components/layout/PageHeader";

import { getSettings } from "utils/config/config";

// getServerSideProps (not getStaticProps): this Docker image's multi-stage
// build runs `next build` before the real config/ directory is mounted, so a
// statically-generated page would freeze in whatever settings.yaml's
// auto-copied template contains at build time - the dashboard works around
// this with its own /api/revalidate self-trigger, but a per-request render
// is simpler and gives every request the live, mounted config.
export async function getServerSideProps() {
  const { providers, ...settings } = getSettings();
  return { props: { initialSettings: settings } };
}

export default function BackupsPage({ initialSettings }) {
  return (
    <PageBackground initialSettings={initialSettings}>
      <div className="flex flex-col m-4 sm:m-8 mb-2">
        <PageHeader title="Backups" />
        <ConfigBackup />
        <VmList />
      </div>
    </PageBackground>
  );
}
