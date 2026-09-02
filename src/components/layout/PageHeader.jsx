import NavHeader from "components/layout/NavHeader";

// The title row shared by every non-dashboard page (/widgets, /backups,
// /security). The hamburger nav sits inline, immediately left of the <h1>,
// so the floating nav button can never overlap the page title the way it
// did when NavHeader was absolutely positioned over the top-left corner of
// every page. The dashboard has no <h1>, so it keeps rendering NavHeader in
// its floating variant instead of using this component.
export default function PageHeader({ title }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <NavHeader inline />
      <h1 className="text-theme-800 dark:text-theme-300 text-xl font-medium">{title}</h1>
    </div>
  );
}
