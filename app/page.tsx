"use client";

import { useState } from "react";
import Link from "next/link";
import Sidebar from "@/components/Sidebar";
import CreateIncidentModal from "@/components/CreateIncidentModal";
import { useIncidentContext } from "@/context/IncidentContext";
import { Severity } from "@/lib/types";

const severityStyles: Record<Severity, string> = {
  Critical: "bg-red-500/15 text-red-400",
  High: "bg-orange-500/15 text-orange-300",
  Medium: "bg-yellow-500/15 text-yellow-300",
  Low: "bg-emerald-500/15 text-emerald-300",
};

export default function Home() {
  const [activePage, setActivePage] = useState("Dashboard");
  const [search, setSearch] = useState("");

  const {
    incidents,
    addIncident,
    openCount,
    criticalCount,
    isCreateModalOpen,
    openCreateModal,
    closeCreateModal,
    toastMessage,
    setToastMessage,
  } = useIncidentContext();

  const filteredIncidents = incidents.filter((incident) =>
    `${incident.id} ${incident.title} ${incident.service} ${incident.severity} ${incident.status}`
      .toLowerCase()
      .includes(search.toLowerCase())
  );

  const servicesCount = new Set(incidents.map((i) => i.service)).size;
  const resolvedCount = incidents.filter(
    (incident) => incident.status === "Resolved"
  ).length;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 md:flex">
      <Sidebar activeItem={activePage} onItemClick={(item) => setActivePage(item)} />

      <section className="min-w-0 flex-1 p-5 md:p-8">
        {/* Toast confirmation */}
        {toastMessage && (
          <div className="mb-6 flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300 animate-in fade-in slide-in-from-top-2">
            <div className="flex items-center gap-2">
              <svg
                className="h-5 w-5 text-emerald-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <span>{toastMessage}</span>
            </div>
            <button
              type="button"
              onClick={() => setToastMessage(null)}
              className="text-xs text-emerald-400 hover:text-white"
            >
              Dismiss
            </button>
          </div>
        )}

        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm text-slate-500">
              Workspace / {activePage}
            </p>
            <h2 className="mt-2 text-3xl font-bold">{activePage}</h2>
            <p className="mt-2 text-sm text-slate-400">
              Monitor incidents and coordinate service response.
            </p>
          </div>

          <button
            type="button"
            onClick={openCreateModal}
            className="rounded-lg bg-cyan-400 px-4 py-3 text-sm font-bold text-slate-950 transition hover:bg-cyan-300 shadow-lg shadow-cyan-950/20 active:translate-y-0.5 cursor-pointer"
          >
            + Create incident
          </button>
        </header>

        {activePage === "Dashboard" ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {[
                {
                  label: "Open incidents",
                  value: String(openCount),
                  detail: "Active ongoing disruptions",
                  color: "text-cyan-300",
                },
                {
                  label: "Critical incidents",
                  value: String(criticalCount),
                  detail: "Require urgent attention",
                  color: "text-red-400",
                },
                {
                  label: "Services monitored",
                  value: String(servicesCount),
                  detail: "Active production services",
                  color: "text-violet-300",
                },
                {
                  label: "Resolved incidents",
                  value: String(resolvedCount),
                  detail: "Successfully mitigated",
                  color: "text-emerald-400",
                },
              ].map((stat) => (
                <article
                  key={stat.label}
                  className="rounded-2xl border border-slate-800 bg-slate-900 p-5"
                >
                  <p className="text-sm text-slate-400">{stat.label}</p>
                  <p className={`mt-3 text-3xl font-bold ${stat.color}`}>
                    {stat.value}
                  </p>
                  <p className="mt-2 text-xs text-slate-500">
                    {stat.detail}
                  </p>
                </article>
              ))}
            </div>

            <section className="mt-8 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 p-5">
                <div>
                  <h3 className="text-lg font-semibold">Recent incidents</h3>
                  <p className="mt-1 text-sm text-slate-400">
                    Track current and recently resolved incidents
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto">
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search incidents..."
                    aria-label="Search incidents"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none placeholder:text-slate-600 focus:border-cyan-400 sm:w-64"
                  />
                  <Link
                    href="/incidents"
                    className="whitespace-nowrap rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-300 hover:bg-cyan-400/20 transition"
                  >
                    View all incidents →
                  </Link>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="bg-slate-950/60 text-xs uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-5 py-4">Incident</th>
                      <th className="px-5 py-4">Service</th>
                      <th className="px-5 py-4">Severity</th>
                      <th className="px-5 py-4">Status</th>
                      <th className="px-5 py-4">Updated</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-slate-800">
                    {filteredIncidents.slice(0, 6).map((incident) => (
                      <tr
                        key={incident.id}
                        className="transition hover:bg-slate-800/40"
                      >
                        <td className="px-5 py-4">
                          <p className="font-medium text-slate-100">{incident.title}</p>
                          <p className="mt-1 font-mono text-xs text-cyan-400/80">
                            {incident.id}
                          </p>
                        </td>
                        <td className="px-5 py-4 text-slate-300">
                          {incident.service}
                        </td>
                        <td className="px-5 py-4">
                          <span
                            className={`rounded-full px-2.5 py-1 text-xs font-medium ${severityStyles[incident.severity]}`}
                          >
                            {incident.severity}
                          </span>
                        </td>
                        <td className="px-5 py-4 text-slate-300">
                          {incident.status}
                        </td>
                        <td className="px-5 py-4 text-slate-400">
                          {incident.updated}
                        </td>
                      </tr>
                    ))}

                    {filteredIncidents.length === 0 && (
                      <tr>
                        <td
                          colSpan={5}
                          className="px-5 py-10 text-center text-slate-500"
                        >
                          No matching incidents found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <p className="mt-5 text-xs text-slate-500">
              Frontend prototype · Sample data only · Not connected to the
              backend yet
            </p>
          </>
        ) : (
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-8">
            <h3 className="text-xl font-semibold">{activePage}</h3>
            <p className="mt-2 text-sm text-slate-400">
              {activePage === "Incidents"
                ? "The dedicated Incidents management view is ready."
                : "This section is planned and will be implemented next."}
            </p>
            <div className="mt-5 flex gap-3">
              {activePage === "Incidents" ? (
                <Link
                  href="/incidents"
                  className="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-cyan-300 transition"
                >
                  Open Incidents Page
                </Link>
              ) : null}
              <button
                type="button"
                onClick={() => setActivePage("Dashboard")}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
              >
                Back to dashboard
              </button>
            </div>
          </section>
        )}
      </section>

      {/* Shared Create Incident Modal */}
      <CreateIncidentModal
        isOpen={isCreateModalOpen}
        onClose={closeCreateModal}
        onCreate={addIncident}
      />
    </main>
  );
}
