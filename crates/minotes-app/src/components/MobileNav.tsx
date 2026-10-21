import Icon from "./Icon";

interface MobileNavProps {
  activeTab: string;
  onPagesClick: () => void;
  onJournalClick: () => void;
  onSearchClick: () => void;
  onGraphClick: () => void;
  onMenuClick: () => void;
}

export default function MobileNav({
  activeTab,
  onPagesClick,
  onJournalClick,
  onSearchClick,
  onGraphClick,
  onMenuClick,
}: MobileNavProps) {
  const tabs = [
    { id: "pages", label: "Pages", icon: "pages" as const, onClick: onPagesClick },
    { id: "journal", label: "Journal", icon: "journal" as const, onClick: onJournalClick },
    { id: "search", label: "Search", icon: "search" as const, onClick: onSearchClick },
    { id: "graph", label: "Graph", icon: "graph" as const, onClick: onGraphClick },
    { id: "menu", label: "Menu", icon: "sidebar" as const, onClick: onMenuClick },
  ];

  return (
    <nav className="mobile-nav">
      <div className="mobile-nav-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`mobile-nav-tab${activeTab === tab.id ? " active" : ""}`}
            onClick={tab.onClick}
          >
            <span className="mobile-nav-tab-icon"><Icon name={tab.icon} size={20} /></span>
            <span className="mobile-nav-tab-label">{tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
