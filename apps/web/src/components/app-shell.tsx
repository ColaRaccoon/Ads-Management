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
  LogOut,
  Package,
  Settings,
  ShoppingCart,
  Shuffle,
  TableProperties,
  TrendingUp,
  Upload
} from "lucide-react";
import { Permission, roleLabel } from "@/features/auth/auth-types";
import { useAuth } from "@/features/auth/use-auth";
import { DateRangePicker } from "./date-range-picker";

type NavItem = {
  href: string;
  label: string;
  icon: typeof Home;
  requiredPermission: Permission;
};

const navGroups: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Meta",
    items: [
      { href: "/dashboard", label: "Meta Dashboard", icon: Home, requiredPermission: "data.read" },
      { href: "/uploads", label: "Meta Uploads", icon: Upload, requiredPermission: "data.read" },
      { href: "/sales", label: "Meta/Cafe24 Sales", icon: ShoppingCart, requiredPermission: "data.read" },
      { href: "/campaigns", label: "Meta Campaigns", icon: BarChart3, requiredPermission: "data.read" },
      { href: "/adsets", label: "Meta Adsets", icon: TableProperties, requiredPermission: "data.read" },
      { href: "/ads", label: "Meta Ads", icon: Package, requiredPermission: "data.read" },
      { href: "/creative-trends", label: "Meta 소재 추이", icon: TrendingUp, requiredPermission: "data.read" },
      { href: "/daily-report", label: "Meta Daily Report", icon: ClipboardList, requiredPermission: "data.read" },
      { href: "/mappings", label: "Meta Mappings", icon: Shuffle, requiredPermission: "data.read" },
      { href: "/settings/products", label: "Meta Product Settings", icon: Settings, requiredPermission: "data.read" },
      { href: "/change-logs", label: "Meta Change Logs", icon: History, requiredPermission: "data.read" }
    ]
  },
  {
    label: "쿠팡",
    items: [
      { href: "/coupang/dashboard", label: "Coupang Dashboard", icon: Home, requiredPermission: "data.read" },
      { href: "/coupang/uploads", label: "Coupang Uploads", icon: Upload, requiredPermission: "data.read" },
      { href: "/coupang/products", label: "쿠팡 상품 설정", icon: Settings, requiredPermission: "data.read" },
      { href: "/coupang/profit", label: "Coupang Profit Table", icon: TableProperties, requiredPermission: "data.read" },
      { href: "/coupang/ads", label: "Coupang Ads Analysis", icon: Package, requiredPermission: "data.read" },
      { href: "/coupang/daily-report", label: "Coupang Daily Report", icon: ClipboardList, requiredPermission: "data.read" },
      { href: "/coupang/mappings", label: "쿠팡 매핑관리", icon: Shuffle, requiredPermission: "data.read" }
    ]
  }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, can, logout } = useAuth();
  const visibleGroups = visibleNavGroups(can);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <strong>Meta Ads Performance Hub</strong>
          <span>CSV performance operations</span>
        </div>
        <nav className="nav">
          {visibleGroups.map((group) => (
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
          <div className="account-toolbar">
            <div className="account-summary">
              <strong>{user?.name ?? "사용자"}</strong>
              <span>{user?.email ?? "이메일 없음"} · {roleLabel(user?.role)}</span>
            </div>
            <button className="button" type="button" onClick={() => void logout()}>
              <LogOut size={15} />
              로그아웃
            </button>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}

export function visibleNavGroups(can: (permission: Permission) => boolean) {
  return navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => can(item.requiredPermission))
    }))
    .filter((group) => group.items.length > 0);
}
