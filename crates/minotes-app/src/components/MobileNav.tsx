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
    { id: "pages", label: "Pages", icon: "\u{1F4C4}", onClick: onPagesClick },
    { id: "journal", label: "Journal", icon: "\u{1F4D3}", onClick: onJournalClick },
    { id: "search", label: "Search", icon: "\u{1F50D}", onClick: onSearchClick },
    { id: "graph", label: "Graph", icon: "\u{1F578}\uFE0F", onClick: onGraphClick },
    { id: "menu", label: "Menu", icon: "\u2630", onClick: onMenuClick },
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
            <span className="mobile-nav-tab-icon">{tab.icon}</span>
            <span className="mobile-nav-tab-label">{tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
