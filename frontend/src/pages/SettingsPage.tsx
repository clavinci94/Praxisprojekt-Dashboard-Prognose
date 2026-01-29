// src/pages/SettingsPage.tsx
import { useEffect, useState } from "react";
import { showToast } from "../components/Toast";

export default function SettingsPage() {
  const [apiKey, setApiKey] = useState("");
  const [refreshRate, setRefreshRate] = useState("5000");
  const [theme, setTheme] = useState("dark");
  const [loading, setLoading] = useState(false);

  // Load from "LocalStorage" mock
  useEffect(() => {
    setApiKey(localStorage.getItem("bi_api_key") || "sk-live-84920491...");
    setRefreshRate(localStorage.getItem("bi_refresh_rate") || "5000");
  }, []);

  const handleSave = () => {
    setLoading(true);
    // Simuliere API Call
    setTimeout(() => {
      localStorage.setItem("bi_api_key", apiKey);
      localStorage.setItem("bi_refresh_rate", refreshRate);
      setLoading(false);
      showToast("Settings saved successfully", "success");
    }, 800);
  };

  return (
    <div style={{ maxWidth: 800 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1>System Settings</h1>
      </div>

      <div className="card" style={{ padding: 24, marginBottom: 24 }}>
        <h2>Connection Preferences</h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>
          Manage how the dashboard connects to the orchestration engine.
        </p>

        <div style={{ display: "grid", gap: 16 }}>
          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 6 }}>API Endpoint Key</label>
            <input
              className="input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              style={{ width: "100%", padding: "8px 12px", background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text-primary)", borderRadius: "4px" }}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 6 }}>Polling Interval (ms)</label>
              <select
                value={refreshRate}
                onChange={(e) => setRefreshRate(e.target.value)}
                style={{ width: "100%", padding: "8px 12px", background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text-primary)", borderRadius: "4px" }}
              >
                <option value="2000">2000 ms (Fast)</option>
                <option value="5000">5000 ms (Standard)</option>
                <option value="15000">15000 ms (Slow)</option>
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 6 }}>Theme</label>
              <select
                value={theme}
                onChange={(e) => setTheme(e.target.value)}
                style={{ width: "100%", padding: "8px 12px", background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text-primary)", borderRadius: "4px" }}
              >
                <option value="dark">Enterprise Dark</option>
                <option value="light">Light (Coming Soon)</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={loading}>
          {loading ? "Saving..." : "Save Changes"}
        </button>
        <button className="btn" onClick={() => showToast("Changes discarded", "info")}>Cancel</button>
      </div>
    </div>
  );
}