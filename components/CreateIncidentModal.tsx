"use client";

import React, { useState, useEffect, useRef } from "react";
import { CreateIncidentInput, Severity, Priority, AssignedUser } from "@/lib/types";

interface CreateIncidentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (incident: CreateIncidentInput) => void;
  nextIncidentId?: string;
}

const COMMON_SERVICES = [
  "Payment Gateway",
  "PostgreSQL Primary",
  "Auth & Identity",
  "Notification Service",
  "Caching Tier",
  "Messaging Gateway",
  "Elasticsearch Cluster",
  "Order Service",
  "API Gateway",
  "Billing Service",
];

const TEAM_MEMBERS: AssignedUser[] = [
  { name: "Sarah Chen", email: "sarah.chen@incidentops.internal", avatarInitials: "SC" },
  { name: "Alex Rivera", email: "alex.rivera@incidentops.internal", avatarInitials: "AR" },
  { name: "David Kim", email: "david.kim@incidentops.internal", avatarInitials: "DK" },
  { name: "Elena Rostova", email: "elena.rostova@incidentops.internal", avatarInitials: "ER" },
  { name: "Marcus Vance", email: "marcus.vance@incidentops.internal", avatarInitials: "MV" },
  { name: "Priya Patel", email: "priya.patel@incidentops.internal", avatarInitials: "PP" },
  { name: "Jordan Taylor", email: "jordan.taylor@incidentops.internal", avatarInitials: "JT" },
  { name: "Unassigned", email: "unassigned@incidentops.internal", avatarInitials: "--" },
];

export default function CreateIncidentModal({
  isOpen,
  onClose,
  onCreate,
  nextIncidentId = "INC-1043",
}: CreateIncidentModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [service, setService] = useState(COMMON_SERVICES[0]);
  const [customService, setCustomService] = useState("");
  const [severity, setSeverity] = useState<Severity>("High");
  const [priority, setPriority] = useState<Priority>("P2");
  const [assigneeName, setAssigneeName] = useState(TEAM_MEMBERS[0].name);

  // Validation error state
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);

  const titleInputRef = useRef<HTMLInputElement>(null);

  // Focus title input when modal opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        titleInputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  // Handle ESC key to cancel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        handleCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  if (!isOpen) return null;

  // Sync priority suggestion when severity changes (unless user explicitly picks another)
  const handleSeverityChange = (newSev: Severity) => {
    setSeverity(newSev);
    if (newSev === "Critical") setPriority("P1");
    else if (newSev === "High") setPriority("P2");
    else if (newSev === "Medium") setPriority("P3");
    else if (newSev === "Low") setPriority("P4");
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!title.trim()) {
      newErrors.title = "Incident title is required.";
    } else if (title.trim().length < 4) {
      newErrors.title = "Title must be at least 4 characters long.";
    }

    if (!description.trim()) {
      newErrors.description = "Incident description is required.";
    } else if (description.trim().length < 8) {
      newErrors.description = "Description must provide sufficient detail (at least 8 characters).";
    }

    if (service === "custom" && !customService.trim()) {
      newErrors.service = "Affected service name is required.";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setHasAttemptedSubmit(true);

    if (!validate()) {
      return;
    }

    const finalService = service === "custom" ? customService.trim() : service;
    const assignedUser =
      TEAM_MEMBERS.find((m) => m.name === assigneeName) || TEAM_MEMBERS[0];

    onCreate({
      title: title.trim(),
      description: description.trim(),
      service: finalService,
      severity,
      priority,
      assignedUser,
    });

    handleReset();
    onClose();
  };

  const handleReset = () => {
    setTitle("");
    setDescription("");
    setService(COMMON_SERVICES[0]);
    setCustomService("");
    setSeverity("High");
    setPriority("P2");
    setAssigneeName(TEAM_MEMBERS[0].name);
    setErrors({});
    setHasAttemptedSubmit(false);
  };

  const handleCancel = () => {
    handleReset();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-incident-dialog-title"
    >
      <div className="relative w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl text-slate-100 my-8">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-semibold uppercase text-cyan-400 tracking-wider">
                Create New Incident
              </span>
              <span className="text-xs font-mono text-slate-500 bg-slate-800/80 px-2 py-0.5 rounded border border-slate-700/50">
                {nextIncidentId}
              </span>
            </div>
            <h2
              id="create-incident-dialog-title"
              className="text-xl font-bold mt-1 text-white"
            >
              Report Service Incident
            </h2>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            className="rounded-lg p-2 text-slate-400 hover:text-white hover:bg-slate-800 transition"
            aria-label="Cancel and close dialog"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Top summary validation error banner */}
        {hasAttemptedSubmit && Object.keys(errors).length > 0 && (
          <div
            className="mt-4 rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-300 flex items-center gap-2"
            role="alert"
          >
            <svg
              className="h-4 w-4 flex-shrink-0 text-red-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <span>Please correct the highlighted fields below before submitting.</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-4">
          {/* Title */}
          <div>
            <label
              htmlFor="incident-title"
              className="block text-xs font-medium uppercase tracking-wider text-slate-400 mb-1.5"
            >
              Incident Title <span className="text-red-400">*</span>
            </label>
            <input
              id="incident-title"
              ref={titleInputRef}
              type="text"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (errors.title) {
                  setErrors((prev) => {
                    const copy = { ...prev };
                    delete copy.title;
                    return copy;
                  });
                }
              }}
              placeholder="e.g. Payment Gateway authorization timeout spike"
              className={`w-full rounded-lg border bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 outline-none transition ${
                errors.title
                  ? "border-red-500/80 focus:border-red-500 focus:ring-1 focus:ring-red-500/30"
                  : "border-slate-700 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400"
              }`}
            />
            {errors.title && (
              <p className="mt-1.5 text-xs text-red-400 flex items-center gap-1" role="alert">
                <span className="font-bold">⚠</span> {errors.title}
              </p>
            )}
          </div>

          {/* Description */}
          <div>
            <label
              htmlFor="incident-description"
              className="block text-xs font-medium uppercase tracking-wider text-slate-400 mb-1.5"
            >
              Description <span className="text-red-400">*</span>
            </label>
            <textarea
              id="incident-description"
              rows={3}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                if (errors.description) {
                  setErrors((prev) => {
                    const copy = { ...prev };
                    delete copy.description;
                    return copy;
                  });
                }
              }}
              placeholder="Describe symptoms, customer impact, error codes, or initial triage notes..."
              className={`w-full rounded-lg border bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 outline-none transition resize-y ${
                errors.description
                  ? "border-red-500/80 focus:border-red-500 focus:ring-1 focus:ring-red-500/30"
                  : "border-slate-700 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400"
              }`}
            />
            {errors.description && (
              <p className="mt-1 text-xs text-red-400 flex items-center gap-1" role="alert">
                <span className="font-bold">⚠</span> {errors.description}
              </p>
            )}
          </div>

          {/* Affected Service */}
          <div>
            <label
              htmlFor="incident-service"
              className="block text-xs font-medium uppercase tracking-wider text-slate-400 mb-1.5"
            >
              Affected Service <span className="text-red-400">*</span>
            </label>
            <select
              id="incident-service"
              value={service}
              onChange={(e) => {
                setService(e.target.value);
                if (errors.service) {
                  setErrors((prev) => {
                    const copy = { ...prev };
                    delete copy.service;
                    return copy;
                  });
                }
              }}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition cursor-pointer"
            >
              {COMMON_SERVICES.map((srv) => (
                <option key={srv} value={srv}>
                  {srv}
                </option>
              ))}
              <option value="custom">Other / Custom Service...</option>
            </select>

            {service === "custom" && (
              <div className="mt-2">
                <input
                  type="text"
                  value={customService}
                  onChange={(e) => {
                    setCustomService(e.target.value);
                    if (errors.service) {
                      setErrors((prev) => {
                        const copy = { ...prev };
                        delete copy.service;
                        return copy;
                      });
                    }
                  }}
                  placeholder="Specify affected service name..."
                  className={`w-full rounded-lg border bg-slate-950 px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-600 outline-none transition ${
                    errors.service
                      ? "border-red-500/80 focus:border-red-500"
                      : "border-slate-700 focus:border-cyan-400"
                  }`}
                />
                {errors.service && (
                  <p className="mt-1 text-xs text-red-400 flex items-center gap-1" role="alert">
                    <span className="font-bold">⚠</span> {errors.service}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Severity & Priority in Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Severity */}
            <div>
              <label
                htmlFor="incident-severity"
                className="block text-xs font-medium uppercase tracking-wider text-slate-400 mb-1.5"
              >
                Severity <span className="text-red-400">*</span>
              </label>
              <select
                id="incident-severity"
                value={severity}
                onChange={(e) => handleSeverityChange(e.target.value as Severity)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition cursor-pointer"
              >
                <option value="Critical">Critical (P1)</option>
                <option value="High">High (P2)</option>
                <option value="Medium">Medium (P3)</option>
                <option value="Low">Low (P4)</option>
              </select>
            </div>

            {/* Priority */}
            <div>
              <label
                htmlFor="incident-priority"
                className="block text-xs font-medium uppercase tracking-wider text-slate-400 mb-1.5"
              >
                Priority <span className="text-red-400">*</span>
              </label>
              <select
                id="incident-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition cursor-pointer"
              >
                <option value="P1">P1 - Critical / Outage</option>
                <option value="P2">P2 - High Impact</option>
                <option value="P3">P3 - Moderate / Degraded</option>
                <option value="P4">P4 - Low / Minor</option>
              </select>
            </div>
          </div>

          {/* Assigned Responder */}
          <div>
            <label
              htmlFor="incident-assignee"
              className="block text-xs font-medium uppercase tracking-wider text-slate-400 mb-1.5"
            >
              Assigned Responder
            </label>
            <select
              id="incident-assignee"
              value={assigneeName}
              onChange={(e) => setAssigneeName(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition cursor-pointer"
            >
              {TEAM_MEMBERS.map((member) => (
                <option key={member.name} value={member.name}>
                  {member.name} {member.name !== "Unassigned" ? `(${member.avatarInitials})` : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Actions: Cancel and Create */}
          <div className="pt-4 flex items-center justify-between border-t border-slate-800">
            <span className="text-[11px] text-slate-500">
              Prototype mode · Local memory store
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleCancel}
                className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-300 hover:text-white hover:bg-slate-800 transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-cyan-400 px-5 py-2.5 text-sm font-bold text-slate-950 hover:bg-cyan-300 transition shadow-lg shadow-cyan-950/20 active:translate-y-0.5 cursor-pointer"
              >
                Create Incident
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
