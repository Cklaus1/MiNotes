import { useState, useEffect, useRef } from 'react';

interface CustomView {
  type: string;
  displayText: string;
  containerEl: HTMLElement;
}

interface Props {
  views: CustomView[];
  onClose: (type: string) => void;
}

export default function CustomViewContainer({ views, onClose }: Props) {
  const [activeTab, setActiveTab] = useState(views[0]?.type ?? '');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    // Clear and mount the active view's container element
    containerRef.current.innerHTML = '';
    const activeView = views.find(v => v.type === activeTab);
    if (activeView) {
      containerRef.current.appendChild(activeView.containerEl);
    }
  }, [activeTab, views]);

  if (views.length === 0) return null;

  return (
    <div className="custom-view-container">
      {/* Tab bar */}
      <div className="custom-view-tabs">
        {views.map(v => (
          <div
            key={v.type}
            className={`custom-view-tab ${activeTab === v.type ? 'active' : ''}`}
            onClick={() => setActiveTab(v.type)}
          >
            {v.displayText}
            <span className="custom-view-tab-close" onClick={e => { e.stopPropagation(); onClose(v.type); }}>&times;</span>
          </div>
        ))}
      </div>
      {/* View content */}
      <div className="custom-view-content" ref={containerRef} />
    </div>
  );
}
