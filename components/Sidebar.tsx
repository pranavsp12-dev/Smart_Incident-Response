"use client";

import Link from "next/link";

interface SidebarProps {
  activeItem: string;
  onItemClick?: (item: string) => void;
}

const navItems: { name: string; href: string; planned?: boolean }[] = [
  { name: "Dashboard", href: "/" },
  { name: "Incidents", href: "/incidents" },
  { name: "Services", href: "/#services", planned: true },
  { name: "Teams", href: "/#teams", planned: true },
  { name: "On-Call", href: "/#on-call", planned: true },
  { name: "Post-Mortems", href: "/#post-mortems", planned: true },
];

export default function Sidebar({ activeItem, onItemClick }: SidebarProps) {
  return (
    <aside className="border-b border-slate-800 bg-slate-900 p-5 md:min-h-screen md:w-64 md:flex-shrink-0 md:border-b-0 md:border-r">
      <div className="mb-8">
        <Link href="/" className="group block">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-cyan-400 group-hover:text-cyan-300 transition">
            IncidentOps
          </p>
          <h1 className="mt-2 text-xl font-bold text-white group-hover:text-cyan-200 transition">
            Response Center
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            Incident management
          </p>
        </Link>
      </div>

      <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
        Workspace
      </p>

      <nav className="flex flex-wrap gap-2 md:flex-col" aria-label="Main Navigation">
        {navItems.map((item) => {
          const isActive = activeItem.toLowerCase() === item.name.toLowerCase();

          if (item.planned && onItemClick) {
            return (
              <button
                key={item.name}
                type="button"
                onClick={() => onItemClick(item.name)}
                className={`rounded-lg px-4 py-3 text-left text-sm transition flex items-center justify-between ${
                  isActive
                    ? "bg-cyan-400/10 font-semibold text-cyan-300"
                    : "text-slate-400 hover:bg-slate-800 hover:text-white"
                }`}
              >
                <span>{item.name}</span>
                <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-500 border border-slate-700/50">
                  Soon
                </span>
              </button>
            );
          }

          return (
            <Link
              key={item.name}
              href={item.href}
              onClick={() => onItemClick?.(item.name)}
              className={`rounded-lg px-4 py-3 text-left text-sm transition flex items-center justify-between ${
                isActive
                  ? "bg-cyan-400/10 font-semibold text-cyan-300"
                  : "text-slate-400 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <span>{item.name}</span>
              {item.planned && (
                <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-500 border border-slate-700/50">
                  Soon
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="mt-10 hidden rounded-xl border border-slate-800 p-4 md:block bg-slate-950/40">
        <p className="text-sm font-semibold text-slate-200">On-call status</p>
        <p className="mt-3 flex items-center gap-2 text-sm text-emerald-400 font-medium">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
          Schedule active
        </p>
        <p className="mt-2 text-xs text-slate-500">
          Illustrative status only
        </p>
      </div>
    </aside>
  );
}

