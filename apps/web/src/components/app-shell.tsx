"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import {
  Activity,
  BarChart3,
  ClipboardList,
  FileDown,
  History,
  Home,
  Package,
  Settings,
  Shuffle,
  TableProperties,
  Upload
} from "lucide-react";
import { DateRangePicker } from "./date-range-picker";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: Home },
  { href: "/uploads", label: "Uploads", icon: Upload },
  { href: "/campaigns", label: "Campaigns", icon: BarChart3 },
  { href: "/adsets", label: "Adsets", icon: TableProperties },
  { href: "/ads", label: "Ads", icon: Package },
  { href: "/daily-report", label: "Daily Report", icon: ClipboardList },
  { href: "/products/performance", label: "Products", icon: BarChart3 },
  { href: "/mappings", label: "Mappings", icon: Shuffle },
  { href: "/settings/products", label: "Product Settings", icon: Settings },
  { href: "/change-logs", label: "Change Logs", icon: History },
  { href: "/reports", label: "Reports", icon: FileDown }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <strong>Meta Ads Performance Hub</strong>
          <span>CSV performance operations</span>
        </div>
        <nav className="nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link key={item.href} className={active ? "active" : ""} href={item.href}>
                <Icon size={17} />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="toolbar">
            <Activity size={18} color="#146c63" />
            <strong>운영 대시보드</strong>
          </div>
          <Suspense fallback={<div className="toolbar" />}>
            <DateRangePicker />
          </Suspense>
        </header>
        {children}
      </main>
    </div>
  );
}
