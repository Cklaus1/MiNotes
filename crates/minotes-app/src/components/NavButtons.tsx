import { goBack, goForward, useNavHistory } from "../lib/navHistory";
import Icon from "./Icon";
import "./navigation.css";

/**
 * Back / forward (lib/navHistory): in the sidebar's action bar, or floating
 * next to the "Show sidebar" button while the sidebar is hidden.
 */
export default function NavButtons({ floating = false }: { floating?: boolean }) {
  const { canBack, canForward } = useNavHistory();
  return (
    <div className={`nav-buttons${floating ? " nav-buttons-floating" : ""}`} role="group" aria-label="History" data-testid="nav-buttons">
      <button
        className="nav-btn"
        onClick={() => { void goBack(); }}
        disabled={!canBack}
        title={canBack ? "Back (Ctrl+[ or the mouse's back button)" : "Back — nothing to go back to yet"}
        aria-label="Back"
        data-testid="nav-back"
      >
        <Icon name="arrow-left" size={15} />
      </button>
      <button
        className="nav-btn"
        onClick={() => { void goForward(); }}
        disabled={!canForward}
        title={canForward ? "Forward (Ctrl+])" : "Forward — nothing ahead"}
        aria-label="Forward"
        data-testid="nav-forward"
      >
        <Icon name="arrow-right" size={15} />
      </button>
    </div>
  );
}
