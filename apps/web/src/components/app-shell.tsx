"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import {
  Activity,
  BarChart3,
  ClipboardList,
  History,
  Home,
  Package,
  Settings,
  ShoppingCart,
  Shuffle,
  TableProperties,
  Upload
} from "lucide-react";
import { DateRangePicker } from "./date-range-picker";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: Home },
  { href: "/uploads", label: "Uploads", icon: Upload },
  { href: "/sales", label: "판매", icon: ShoppingCart },
  { href: "/campaigns", label: "Campaigns", icon: BarChart3 },
  { href: "/adsets", label: "Adsets", icon: TableProperties },
  { href: "/ads", label: "Ads", icon: Package },
  { href: "/daily-report", label: "Daily Report", icon: ClipboardList },
  { href: "/mappings", label: "Mappings", icon: Shuffle },
  { href: "/settings/products", label: "Product Settings", icon: Settings },
  { href: "/change-logs", label: "Change Logs", icon: History }
];

const navGroups = [
  {
    label: "Meta",
    items: [
      { href: "/dashboard", label: "Meta Dashboard", icon: Home },
      { href: "/uploads", label: "Meta Uploads", icon: Upload },
      { href: "/sales", label: "Meta/Cafe24 Sales", icon: ShoppingCart },
      { href: "/campaigns", label: "Meta Campaigns", icon: BarChart3 },
      { href: "/adsets", label: "Meta Adsets", icon: TableProperties },
      { href: "/ads", label: "Meta Ads", icon: Package },
      { href: "/daily-report", label: "Meta Daily Report", icon: ClipboardList },
      { href: "/mappings", label: "Meta Mappings", icon: Shuffle },
      { href: "/settings/products", label: "Meta Product Settings", icon: Settings },
      { href: "/change-logs", label: "Meta Change Logs", icon: History }
    ]
  },
  {
    label: "쿠팡",
    items: [
      { href: "/coupang/dashboard", label: "Coupang Dashboard", icon: Home },
      { href: "/coupang/uploads", label: "Coupang Uploads", icon: Upload },
      { href: "/coupang/products", label: "쿠팡 상품 설정", icon: Settings },
      { href: "/coupang/profit", label: "Coupang Profit Table", icon: TableProperties },
      { href: "/coupang/ads", label: "Coupang Ads Analysis", icon: Package },
      { href: "/coupang/daily-report", label: "Coupang Daily Report", icon: ClipboardList },
      { href: "/coupang/mappings", label: "쿠팡 매핑관리", icon: Shuffle }
    ]
  }
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
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{group.label}</span>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <Link key={item.href} className={active ? "active" : ""} href={item.href}>
                    <Icon size={17} />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
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
