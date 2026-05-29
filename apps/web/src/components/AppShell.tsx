"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Boxes,
  ClipboardList,
  FileSpreadsheet,
  GitBranch,
  LayoutDashboard,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  Table2,
  UploadCloud
} from "lucide-react";
import { DateRangePicker } from "./DateRangePicker";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/uploads", label: "Uploads", icon: UploadCloud },
  { href: "/adsets", label: "Adsets", icon: Table2 },
  { href: "/products/performance", label: "Products", icon: Boxes },
  { href: "/mappings", label: "Mappings", icon: GitBranch },
  { href: "/settings/products", label: "Product Settings", icon: SlidersHorizontal },
  { href: "/change-logs", label: "Change Logs", icon: ClipboardList },
  { href: "/reports", label: "Reports", icon: FileSpreadsheet }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <BarChart3 size={22} />
          <span>Meta Ads Performance Hub</span>
        </div>
        <nav className="nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link key={item.href} className={active ? "active" : ""} href={item.href}>
                <Icon size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="main">
        <div className="topbar">
          <DateRangePicker />
          <button className="btn icon" title="새로고침" onClick={() => window.location.reload()}>
            <RefreshCw size={17} />
          </button>
        </div>
        {children}
      </main>
    </div>
  );
}
