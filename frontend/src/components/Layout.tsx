import { useMemo, useState } from "react";
import type { ReactNode } from "react";

export type NavKey = "runs" | "forecast" | "forecastPowerbi" | "settings";

type LayoutProps = {
  children: ReactNode;
  active: NavKey;
  onNavigate: (key: NavKey) => void;
};

const NAV: Array<{ key: NavKey; label: string; sub: string; icon: string }> = [
  { key: "forecastPowerbi", label: "Cockpit", sub: "Dashboard & Trends", icon: "C" },
  { key: "forecast", label: "Planung & KPIs", sub: "Forecast & Kennzahlen", icon: "K" },
  { key: "runs", label: "Prognosen", sub: "Historie & Status", icon: "P" },
  { key: "settings", label: "Einstellungen", sub: "Konfiguration", icon: "S" },
];

type Tenant = "clerion" | "Kunde";

export function Layout({ children, active, onNavigate }: LayoutProps) {
  const [tenant, setTenant] = useState<Tenant>("Kunde");

  const tenantMeta = useMemo(() => {
    if (tenant === "clerion") {
      return {
        badge: "Clerion • Intern",
        title: "Intern",
        desc: "Betrieb, Orchestrierung & Monitoring",
        hint: "Erweiterte Funktionen und Betriebskennzahlen.",
      };
    }
    return {
      badge: "Kunde • Kundenansicht",
      title: "Kundenansicht",
      desc: "Prognose & KPI-Übersicht (sum_weight in kg)",
      hint: "Fokus auf Forecast, KPIs und operative Planung.",
    };
  }, [tenant]);

  return (
    <div className="appShell">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebarTop">
          <div className="brand" title={tenantMeta.badge}>
            <div className="cl-logo" />
            <div className="brandText">
              <div className="brandTitle">Forecasting UI</div>
              <div className="brandSub">{tenantMeta.badge}</div>
            </div>
          </div>

          {/* Ansicht: sauber als Panel (Desktop: Segments, Mobile: Select) */}
          <section className="tenantPanel" aria-label="Ansicht auswählen" style={{ marginTop: 12 }}>
            <div className="tenantPanelHead">
              <div className="tenantPanelLabel">Ansicht</div>
              <div className="tenantPanelValue" aria-live="polite">
                {tenantMeta.title}
              </div>
            </div>

            <div className="tenantSegments" role="tablist" aria-label="Ansicht umschalten">
              <button
                type="button"
                role="tab"
                aria-selected={tenant === "Kunde"}
                className={`tenantSegment ${tenant === "Kunde" ? "tenantSegmentActive" : ""}`}
                onClick={() => setTenant("Kunde")}
              >
                Kunde
                <span className="tenantSegmentSub">Kunde</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={tenant === "clerion"}
                className={`tenantSegment ${tenant === "clerion" ? "tenantSegmentActive" : ""}`}
                onClick={() => setTenant("clerion")}
              >
                Clerion
                <span className="tenantSegmentSub">Intern</span>
              </button>
            </div>

            {/* Mobile Fallback */}
            <label className="srOnly" htmlFor="tenantSelect">
              Ansicht wählen
            </label>
            <select
              id="tenantSelect"
              value={tenant}
              onChange={(e) => setTenant(e.target.value as Tenant)}
              className="tenantSelect"
              aria-label="Ansicht wählen"
            >
              <option value="Kunde"> (Kunde)</option>
              <option value="clerion">Clerion (Intern)</option>
            </select>

            <div className="tenantPanelDesc">{tenantMeta.desc}</div>
            <div className="tenantPanelHint">{tenantMeta.hint}</div>
          </section>
        </div>

        <div className="navDivider" />

        <nav className="nav" aria-label="Navigation">
          {NAV.map((item) => {
            const isActive = item.key === active;
            return (
              <button
                key={item.key}
                className={`navItem ${isActive ? "navItemActive" : ""}`}
                onClick={() => onNavigate(item.key)}
              >
                <div className="navIcon" aria-hidden="true">
                  {item.icon}
                </div>
                <div className="navTextWrap">
                  <div className="navText">{item.label}</div>
                  <div className="navSub">{item.sub}</div>
                </div>
              </button>
            );
          })}
        </nav>

        <div style={{ marginTop: "auto" }}>
          <div className="pill" style={{ marginTop: 12 }}>
            <span className="dotLive" aria-hidden="true" />
            <div className="pillLabel">Live UI (Mock Data)</div>
          </div>
        </div>
      </aside>

      {/* Main column: wichtig für Flex/Overflow laut App.css */}
      <div className="mainCol">
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
