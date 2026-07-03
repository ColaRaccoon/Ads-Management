"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  ClipboardList,
  GitBranch,
  Layers3,
  LayoutDashboard,
  Package,
  RefreshCw,
  Settings2,
  Sparkles,
  SlidersHorizontal,
  Table2,
  UploadCloud
} from "lucide-react";
import { DateRangePicker } from "./DateRangePicker";

const navGroups = [
  {
    label: "Meta",
    items: [
      { href: "/dashboard", label: "Meta Dashboard", icon: LayoutDashboard },
      { href: "/uploads", label: "Meta Uploads", icon: UploadCloud },
      { href: "/campaigns", label: "Meta Campaigns", icon: Layers3 },
      { href: "/adsets", label: "Meta Adsets", icon: Table2 },
      { href: "/ads", label: "Meta Ads", icon: Sparkles },
      { href: "/mappings", label: "Meta Mappings", icon: GitBranch },
      { href: "/settings/products", label: "Meta Product Settings", icon: SlidersHorizontal },
      { href: "/change-logs", label: "Meta Change Logs", icon: ClipboardList }
    ]
  },
  {
    label: "쿠팡",
    items: [
      { href: "/coupang/dashboard", label: "Coupang Dashboard", icon: LayoutDashboard },
      { href: "/coupang/uploads", label: "Coupang Uploads", icon: UploadCloud },
      { href: "/coupang/products", label: "쿠팡 상품 설정", icon: Package },
      { href: "/coupang/profit", label: "Coupang Profit Table", icon: Table2 },
      { href: "/coupang/ads", label: "Coupang Ads Analysis", icon: Sparkles },
      { href: "/coupang/daily-report", label: "Coupang Daily Report", icon: ClipboardList },
      { href: "/coupang/mappings", label: "쿠팡 매핑관리", icon: GitBranch }
    ]
  }
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
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{group.label}</span>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <Link key={item.href} className={active ? "active" : ""} href={item.href}>
                    <Icon size={18} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
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
