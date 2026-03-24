import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 32,
          background: "#1e1e2e",
          color: "#f38ba8",
          fontFamily: "monospace",
          fontSize: 14,
          height: "100vh",
          overflow: "auto",
        }}>
          <h2 style={{ color: "#cdd6f4" }}>MiNotes crashed</h2>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 16 }}>
            {this.state.error.message}
          </pre>
          <pre style={{ color: "#a6adc8", marginTop: 8, fontSize: 12 }}>
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload(); }}
            style={{
              marginTop: 16,
              padding: "8px 16px",
              background: "#89b4fa",
              color: "#1e1e2e",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
