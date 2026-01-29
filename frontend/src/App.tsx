import { Routes, Route, useLocation, useNavigate } from "react-router-dom";

import { Layout, type NavKey } from "./components/Layout";

import ExecutiveDashboard from "./pages/ExecutiveDashboard";
import OverviewPage from "./pages/OverviewPage";
import SettingsPage from "./pages/SettingsPage";
import PowerBiForecastDashboard from "./pages/PowerBiForecastDashboard";

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();

  const active: NavKey =
    location.pathname.startsWith("/overview") ? "forecastPowerbi" :
    location.pathname.startsWith("/forecast") ? "forecast" :
    location.pathname.startsWith("/settings") ? "settings" :
    "runs";

  return (
    <Layout
      active={active}
      onNavigate={(key) => {
        if (key === "forecastPowerbi") navigate("/overview");
        else if (key === "forecast") navigate("/forecast");
        else if (key === "settings") navigate("/settings");
        else navigate("/");
      }}
    >
      <Routes>
        <Route path="/" element={<ExecutiveDashboard />} />
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/forecast" element={<PowerBiForecastDashboard />} />
        <Route path="/settings" element={<SettingsPage />} />

        <Route path="*" element={<ExecutiveDashboard />} />
      </Routes>
    </Layout>
  );
}
