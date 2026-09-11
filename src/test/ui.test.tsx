import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/ui";
import { DataTable } from "../components/DataTable";

vi.mock("../hooks/queries", () => import("./mockQueries"));

// auth is controlled per test
const auth = { loading: false, session: null as null | { user: { id: string; email: string } }, isAdmin: null as boolean | null, adminName: "", signIn: vi.fn(async () => null as string | null), signOut: vi.fn(async () => {}) };
vi.mock("../hooks/useAuth", () => ({ useAuth: () => auth, AuthProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../lib/supabase", () => ({ isConfigured: true, supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }), auth: {}, channel: () => ({ on: () => ({ subscribe: () => ({}) }) }), removeChannel: () => {} }, unwrap: (r: { data: unknown }) => r.data, BUSINESS_WHATSAPP: "17879684078" }));

import App from "../App";

function mount(path: string) {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><ToastProvider><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></ToastProvider></QueryClientProvider>);
}

beforeEach(() => { cleanup(); auth.session = null; auth.isAdmin = null; auth.signIn.mockClear(); });

describe("authentication guard", () => {
  it("shows the login screen to anonymous visitors and hides financial pages", () => {
    mount("/orders");
    expect(screen.getByRole("heading", { name: /Finance Dashboard/i })).toBeInTheDocument();
    expect(screen.queryByText(/Review Your Order|PB-2026/)).not.toBeInTheDocument();
  });
  it("submits credentials and shows Supabase errors", async () => {
    auth.signIn.mockResolvedValueOnce("Invalid login credentials");
    mount("/login");
    fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: "x@y.z" } });
    fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: /Sign in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid login credentials");
    expect(auth.signIn).toHaveBeenCalledWith("x@y.z", "pw");
  });
  it("denies a signed-in user who is not an approved admin", () => {
    auth.session = { user: { id: "u", email: "stranger@example.com" } }; auth.isAdmin = false;
    mount("/orders");
    expect(screen.getByText(/not an approved administrator/i)).toBeInTheDocument();
    expect(screen.queryByText(/PB-2026-00001/)).not.toBeInTheDocument();
  });
  it("lets an approved admin in", async () => {
    auth.session = { user: { id: "u", email: "owner@example.com" } }; auth.isAdmin = true; auth.adminName = "Owner";
    mount("/orders?all=1");
    expect(await screen.findByRole("heading", { name: "Orders" })).toBeInTheDocument();
    expect(screen.getAllByText("PB-2026-00001").length).toBeGreaterThan(0);
  });
});

describe("dashboard rendering", () => {
  it("shows KPI cards with formulas and never counts tax as sales", async () => {
    auth.session = { user: { id: "u", email: "o@x" } }; auth.isAdmin = true;
    mount("/");
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Net sales")).toBeInTheDocument();
    expect(screen.getByText("Sales tax collected")).toBeInTheDocument();
  });
  it("order detail shows the WhatsApp and Maps links and status workflow", async () => {
    auth.session = { user: { id: "u", email: "o@x" } }; auth.isAdmin = true;
    mount("/orders/o1");
    expect(await screen.findByRole("heading", { name: "PB-2026-00001" })).toBeInTheDocument();
    const wa = screen.getByRole("link", { name: /WhatsApp customer/i });
    expect(wa.getAttribute("href")).toMatch(/^https:\/\/wa\.me\/12145550101\?text=/);
    expect(screen.getByRole("link", { name: /Open in Maps/i }).getAttribute("href")).toContain("google.com/maps");
    expect(screen.getByRole("button", { name: "Cancelled" })).toBeInTheDocument();
  });
});

describe("responsive DataTable", () => {
  const rows = [{ id: "1", name: "B", amount: 5 }, { id: "2", name: "A", amount: 10 }];
  const cols = [{ key: "name", header: "Name", primary: true }, { key: "amount", header: "Amount", numeric: true }];
  it("renders both a table (desktop) and cards (mobile) and sorts", () => {
    render(<DataTable rows={rows} columns={cols} rowKey={(r) => r.id} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(document.querySelectorAll(".md\\:hidden .card").length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: /Amount/ }));
    const cells = [...document.querySelectorAll("tbody tr td:first-child")].map((c) => c.textContent);
    expect(cells).toEqual(["A", "B"]); // desc by amount
    fireEvent.click(screen.getByRole("button", { name: /Amount/ }));
    expect([...document.querySelectorAll("tbody tr td:first-child")].map((c) => c.textContent)).toEqual(["B", "A"]);
  });
  it("paginates", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: "n" + i, amount: i }));
    render(<DataTable rows={many} columns={cols} rowKey={(r) => r.id} pageSize={25} />);
    expect(screen.getByText(/page 1 of 2/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/page 2 of 2/)).toBeInTheDocument();
  });
});
