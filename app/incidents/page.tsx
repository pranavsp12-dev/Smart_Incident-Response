"use client";

import { useState, useMemo } from "react";
import Sidebar from "@/components/Sidebar";
import CreateIncidentModal from "@/components/CreateIncidentModal";
import { useIncidentContext } from "@/context/IncidentContext";
import { Severity, Status, Priority } from "@/lib/types";

const severityBadgeStyles: Record<Severity, string> = {
  Critical: "bg-red-500/15 text-red-400 border-red-500/30",
  High: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  Medium: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30",
  Low: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
};

const priorityBadgeStyles: Record<Priority, string> = {
  P1: "bg-red-950/60 text-red-300 border-red-800/60",
  P2: "bg-orange-950/60 text-orange-300 border-orange-800/60",
  P3: "bg-yellow-950/60 text-yellow-300 border-yellow-800/60",
  P4: "bg-blue-950/60 text-blue-300 border-blue-800/60",
};

const statusBadgeStyles: Record<Status, { style: string; dot: string }> = {
  Investigating: {
    style: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    dot: "bg-amber-400 animate-pulse",
  },
  Identified: {
    style: "bg-sky-500/15 text-sky-300 border-sky-500/30",
    dot: "bg-sky-400",
  },
  Monitoring: {
    style: "bg-purple-500/15 text-purple-300 border-purple-500/30",
    dot: "bg-purple-400",
  },
  Resolved: {
    style: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    dot: "bg-emerald-400",
  },
};

export default function IncidentsPage() {
  const {
    incidents,
    addIncident,
    isCreateModalOpen,
    openCreateModal,
    closeCreateModal,
    toastMessage,
    setToastMessage,
  } = useIncidentContext();

  const [search, setSearch] = useState("");
  const [selectedSeverity, setSelectedSeverity] = useState<string>("ALL");
  const [selectedStatus, setSelectedStatus] = useState<string>("ALL");

  // Filtered incidents based on search (ID, Title, or Description), Severity, and Status
  const filteredIncidents = useMemo(() => {
    return incidents.filter((incident) => {
      const query = search.trim().toLowerCase();
      const matchesSearch =
        query === "" ||
        incident.title.toLowerCase().includes(query) ||
        incident.id.toLowerCase().includes(query) ||
        (incident.description &&
          incident.description.toLowerCase().includes(query));

      const matchesSeverity =
        selectedSeverity === "ALL" || incident.severity === selectedSeverity;

      const matchesStatus =
        selectedStatus === "ALL" || incident.status === selectedStatus;

      return matchesSearch && matchesSeverity && matchesStatus;
    });
  }, [incidents, search, selectedSeverity, selectedStatus]);

  const hasActiveFilters =
    search.trim() !== "" ||
    selectedSeverity !== "ALL" ||
    selectedStatus !== "ALL";

  const handleResetFilters = () => {
    setSearch("");
    setSelectedSeverity("ALL");
    setSelectedStatus("ALL");
  };

  // Metric counts derived from incidents state
  const totalCount = incidents.length;
  const criticalCount = incidents.filter(
    (inc) => inc.severity === "Critical" && inc.status !== "Resolved"
  ).length;
  const investigatingCount = incidents.filter(
    (inc) => inc.status === "Investigating"
  ).length;
  const resolvedCount = incidents.filter(
    (inc) => inc.status === "Resolved"
  ).length;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 md:flex">
      {/* Shared Reusable Sidebar */}
      <Sidebar activeItem="Incidents" />

      {/* Main Content Area */}
      <section className="min-w-0 flex-1 p-5 md:p-8">
        {/* Toast Alert */}
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

        {/* Page Header */}
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span>Workspace</span>
              <span>/</span>
              <span className="text-slate-300 font-medium">Incidents</span>
            </div>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-white">
              Incidents
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Track, triage, and collaborate on active service disruptions and resolved incidents.
            </p>
          </div>

          <button
            type="button"
            onClick={openCreateModal}
            className="flex items-center gap-2 rounded-lg bg-cyan-400 px-4 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-cyan-300 shadow-lg shadow-cyan-950/20 active:translate-y-0.5 cursor-pointer"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
                d="M12 4v16m8-8H4"
              />
            </svg>
            Create Incident
          </button>
        </header>

        {/* Incident Summary Badges */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3 sm:p-4">
            <span className="text-xs text-slate-400 font-medium">Total Tracked</span>
            <p className="mt-1 text-2xl font-bold text-slate-100">{totalCount}</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3 sm:p-4">
            <span className="text-xs text-red-400/90 font-medium">Active Critical</span>
            <p className="mt-1 text-2xl font-bold text-red-400">{criticalCount}</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3 sm:p-4">
            <span className="text-xs text-amber-400/90 font-medium">Investigating</span>
            <p className="mt-1 text-2xl font-bold text-amber-300">{investigatingCount}</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3 sm:p-4">
            <span className="text-xs text-emerald-400/90 font-medium">Resolved</span>
            <p className="mt-1 text-2xl font-bold text-emerald-400">{resolvedCount}</p>
          </div>
        </div>

        {/* Filter and Search Bar Controls */}
        <div className="mb-6 rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            {/* Search Input */}
            <div className="relative flex-1 max-w-md">
              <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-slate-500">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by title, ID, or description..."
                aria-label="Search incidents by title, ID, or description"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 pl-9 pr-8 py-2 text-sm text-slate-100 placeholder:text-slate-600 outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute inset-y-0 right-0 flex items-center pr-2.5 text-slate-500 hover:text-slate-300"
                  aria-label="Clear search text"
                >
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
              )}
            </div>

            {/* Filter Controls: Severity & Status */}
            <div className="flex flex-wrap items-center gap-3">
              {/* Severity Dropdown */}
              <div className="flex items-center gap-2">
                <label
                  htmlFor="severity-select"
                  className="text-xs font-medium uppercase tracking-wider text-slate-400 whitespace-nowrap"
                >
                  Severity:
                </label>
                <select
                  id="severity-select"
                  value={selectedSeverity}
                  onChange={(e) => setSelectedSeverity(e.target.value)}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-400 transition cursor-pointer"
                >
                  <option value="ALL">All Severities</option>
                  <option value="Critical">Critical</option>
                  <option value="High">High</option>
                  <option value="Medium">Medium</option>
                  <option value="Low">Low</option>
                </select>
              </div>

              {/* Status Dropdown */}
              <div className="flex items-center gap-2">
                <label
                  htmlFor="status-select"
                  className="text-xs font-medium uppercase tracking-wider text-slate-400 whitespace-nowrap"
                >
                  Status:
                </label>
                <select
                  id="status-select"
                  value={selectedStatus}
                  onChange={(e) => setSelectedStatus(e.target.value)}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-400 transition cursor-pointer"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="Investigating">Investigating</option>
                  <option value="Identified">Identified</option>
                  <option value="Monitoring">Monitoring</option>
                  <option value="Resolved">Resolved</option>
                </select>
              </div>

              {/* Reset Filters Button */}
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={handleResetFilters}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-700 hover:text-white transition cursor-pointer"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                  Reset
                </button>
              )}
            </div>
          </div>

          {/* Active filter count feedback */}
          <div className="mt-3 flex items-center justify-between border-t border-slate-800/60 pt-3 text-xs text-slate-500">
            <span>
              Showing{" "}
              <strong className="text-slate-300">{filteredIncidents.length}</strong> of{" "}
              <strong className="text-slate-300">{totalCount}</strong> incidents
            </span>
            {hasActiveFilters && (
              <span className="text-cyan-400">Active filters applied</span>
            )}
          </div>
        </div>

        {/* Incidents Table Container */}
        <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-left text-sm">
              <thead className="bg-slate-950/70 text-xs uppercase tracking-wider text-slate-400 border-b border-slate-800">
                <tr>
                  <th scope="col" className="px-5 py-4 font-semibold">Incident ID</th>
                  <th scope="col" className="px-5 py-4 font-semibold">Title & Description</th>
                  <th scope="col" className="px-5 py-4 font-semibold">Service</th>
                  <th scope="col" className="px-5 py-4 font-semibold">Severity</th>
                  <th scope="col" className="px-5 py-4 font-semibold">Priority</th>
                  <th scope="col" className="px-5 py-4 font-semibold">Status</th>
                  <th scope="col" className="px-5 py-4 font-semibold">Assigned User</th>
                  <th scope="col" className="px-5 py-4 font-semibold">Last Updated</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-800/80">
                {filteredIncidents.map((incident) => {
                  const statusConfig = statusBadgeStyles[incident.status];
                  return (
                    <tr
                      key={incident.id}
                      className="transition hover:bg-slate-800/50 group"
                    >
                      {/* Incident ID */}
                      <td className="px-5 py-4 whitespace-nowrap">
                        <span className="inline-flex items-center font-mono text-xs font-semibold px-2.5 py-1 rounded-md bg-cyan-950/40 border border-cyan-800/50 text-cyan-300">
                          {incident.id}
                        </span>
                      </td>

                      {/* Title & Description */}
                      <td className="px-5 py-4">
                        <p className="font-semibold text-slate-100 group-hover:text-cyan-200 transition">
                          {incident.title}
                        </p>
                        {incident.description && (
                          <p className="mt-1 text-xs text-slate-400 line-clamp-1 max-w-sm xl:max-w-md">
                            {incident.description}
                          </p>
                        )}
                      </td>

                      {/* Service */}
                      <td className="px-5 py-4 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 text-slate-300 text-xs font-medium bg-slate-950/60 px-2.5 py-1 rounded-md border border-slate-800">
                          <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
                          {incident.service}
                        </span>
                      </td>

                      {/* Severity */}
                      <td className="px-5 py-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium border ${severityBadgeStyles[incident.severity]}`}
                        >
                          {incident.severity}
                        </span>
                      </td>

                      {/* Priority */}
                      <td className="px-5 py-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center font-mono rounded-md px-2 py-0.5 text-xs font-semibold border ${priorityBadgeStyles[incident.priority]}`}
                        >
                          {incident.priority}
                        </span>
                      </td>

                      {/* Status */}
                      <td className="px-5 py-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border ${statusConfig.style}`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${statusConfig.dot}`} />
                          {incident.status}
                        </span>
                      </td>

                      {/* Assigned User */}
                      <td className="px-5 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <div
                            className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-800 border border-slate-700 text-xs font-bold text-slate-300"
                            title={incident.assignedUser.email}
                          >
                            {incident.assignedUser.avatarInitials}
                          </div>
                          <div>
                            <p className="text-xs font-medium text-slate-200">
                              {incident.assignedUser.name}
                            </p>
                            <p className="text-[11px] text-slate-500">
                              {incident.assignedUser.email}
                            </p>
                          </div>
                        </div>
                      </td>

                      {/* Last Updated */}
                      <td className="px-5 py-4 whitespace-nowrap text-slate-400 text-xs">
                        <div className="flex items-center gap-1.5">
                          <svg
                            className="h-3.5 w-3.5 text-slate-500"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                          </svg>
                          <span>{incident.updated}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {/* Empty State when no incidents match */}
                {filteredIncidents.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-6 py-16 text-center">
                      <div className="mx-auto flex max-w-md flex-col items-center justify-center">
                        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-800/80 border border-slate-700 text-slate-400 mb-4">
                          <svg
                            className="h-7 w-7"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.5}
                              d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                          </svg>
                        </div>
                        <h3 className="text-base font-semibold text-slate-200">
                          No incidents found
                        </h3>
                        <p className="mt-1 text-sm text-slate-400 text-center">
                          {search
                            ? `No incidents matched "${search}".`
                            : "No incidents match the selected severity and status filters."}
                        </p>
                        {hasActiveFilters && (
                          <button
                            type="button"
                            onClick={handleResetFilters}
                            className="mt-4 rounded-lg bg-cyan-400/10 border border-cyan-400/30 px-4 py-2 text-xs font-semibold text-cyan-300 hover:bg-cyan-400/20 transition cursor-pointer"
                          >
                            Clear all filters
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Prototype & Mock Data Notice */}
        <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <p>
            Frontend prototype · Mock data only · Not connected to the backend yet
          </p>
          <p>
            Route: <span className="font-mono text-slate-400">/incidents</span>
          </p>
        </footer>
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
