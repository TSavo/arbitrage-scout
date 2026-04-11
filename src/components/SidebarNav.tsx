"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navLinks = [
  { href: "/", label: "Dashboard", section: "overview" },
  { href: "/opportunities", label: "Opportunities", section: "overview" },
  { href: "/products", label: "Products", section: "catalog" },
  { href: "/categories", label: "Categories", section: "catalog" },
  { href: "/movers", label: "Movers", section: "analysis" },
  { href: "/watchlist", label: "Watchlist", section: "analysis" },
  { href: "/portfolio", label: "Portfolio", section: "analysis" },
  { href: "/platforms", label: "Platforms", section: "analysis" },
  { href: "/scans", label: "Scan History", section: "system" },
];

function NavSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <p
        className="px-3 mb-1.5 text-[10px] font-medium tracking-[0.12em] uppercase select-none"
        style={{ color: "#4a6080" }}
      >
        {label}
      </p>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className="group flex items-center px-3 py-1.5 rounded text-[13px] transition-colors duration-150"
      style={{
        color: active ? "#34d399" : "#a0b4d0",
        background: active ? "#34d39910" : "transparent",
      }}
    >
      {active && (
        <span
          className="absolute left-0 w-[2px] h-4 rounded-r"
          style={{ background: "#34d399" }}
        />
      )}
      <span className="group-hover:text-[#34d399] transition-colors duration-150">
        {label}
      </span>
    </Link>
  );
}

export function SidebarNav() {
  const pathname = usePathname();

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  const sections = [
    { label: "Overview", key: "overview" },
    { label: "Catalog", key: "catalog" },
    { label: "Analysis", key: "analysis" },
    { label: "System", key: "system" },
  ];

  return (
    <nav className="flex-1 py-3 px-2 overflow-y-auto">
      {sections.map((s) => (
        <NavSection key={s.key} label={s.label}>
          {navLinks
            .filter((l) => l.section === s.key)
            .map((link) => (
              <NavLink
                key={link.href}
                href={link.href}
                label={link.label}
                active={isActive(link.href)}
              />
            ))}
        </NavSection>
      ))}
    </nav>
  );
}
