import { Navigate, Route, Routes, Outlet } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { OrdersPage } from "./pages/Orders";
import { OrderDetailPage } from "./pages/OrderDetail";
import { ProductsPage } from "./pages/Products";
import { ProductDetailPage } from "./pages/ProductDetail";
import { PerformancePage } from "./pages/Performance";
import { CustomersPage, CustomerDetailPage } from "./pages/Customers";
import { ExpensesPage } from "./pages/Expenses";
import { PaymentsPage } from "./pages/Payments";
import { DeliveriesPage } from "./pages/Deliveries";
import { ReportsPage } from "./pages/Reports";
import { TaxPage } from "./pages/Tax";
import { InsightsPage } from "./pages/Insights";
import { DataPage } from "./pages/Data";
import { SettingsPage } from "./pages/Settings";

/** Everything under here requires a signed-in, approved admin. The database
 *  enforces the same rule; this only chooses what to render. */
function RequireAdmin() {
  const { loading, session, isAdmin } = useAuth();
  if (loading) return <div className="flex min-h-screen items-center justify-center text-sm text-charcoal/60">Loading…</div>;
  if (!session || isAdmin === false) return <Navigate to="/login" replace />;
  if (isAdmin === null) return <div className="flex min-h-screen items-center justify-center text-sm text-charcoal/60">Verifying access…</div>;
  return <Outlet />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAdmin />}>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="orders" element={<OrdersPage />} />
          <Route path="orders/:id" element={<OrderDetailPage />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="products/:id" element={<ProductDetailPage />} />
          <Route path="performance" element={<PerformancePage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="customers/:id" element={<CustomerDetailPage />} />
          <Route path="expenses" element={<ExpensesPage />} />
          <Route path="payments" element={<PaymentsPage />} />
          <Route path="deliveries" element={<DeliveriesPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="tax" element={<TaxPage />} />
          <Route path="insights" element={<InsightsPage />} />
          <Route path="data" element={<DataPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
