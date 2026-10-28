"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { Incident, CreateIncidentInput } from "@/lib/types";
import { MOCK_INCIDENTS } from "@/lib/mock-data";

interface IncidentContextType {
  incidents: Incident[];
  addIncident: (input: CreateIncidentInput) => Incident;
  openCount: number;
  criticalCount: number;
  isCreateModalOpen: boolean;
  openCreateModal: () => void;
  closeCreateModal: () => void;
  toastMessage: string | null;
  setToastMessage: (msg: string | null) => void;
  resetToMockData: () => void;
}

const IncidentContext = createContext<IncidentContextType | undefined>(
  undefined
);

const STORAGE_KEY = "incidentops_mock_incidents_v2";

export function IncidentProvider({ children }: { children: React.ReactNode }) {
  const [incidents, setIncidents] = useState<Incident[]>(MOCK_INCIDENTS);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Sync from localStorage after client hydration
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setIncidents(parsed);
        }
      }
    } catch {
      // Ignore localStorage access failures (e.g. private mode, disabled storage)
    }
  }, []);

  // Compute next incident ID safely
  const getNextIncidentId = useCallback((currentList: Incident[]) => {
    const numbers = currentList
      .map((inc) => {
        const match = inc.id.match(/\d+/);
        return match ? parseInt(match[0], 10) : 0;
      })
      .filter((n) => !isNaN(n));
    const maxNum = numbers.length > 0 ? Math.max(...numbers) : 1042;
    return `INC-${maxNum + 1}`;
  }, []);

  const addIncident = useCallback(
    (input: CreateIncidentInput): Incident => {
      const defaultUser = {
        name: "Sarah Chen",
        email: "sarah.chen@incidentops.internal",
        avatarInitials: "SC",
      };

      const newId = getNextIncidentId(incidents);
      const newIncident: Incident = {
        id: newId,
        title: input.title.trim(),
        description: input.description.trim(),
        service: input.service.trim(),
        severity: input.severity,
        priority: input.priority,
        status: "Investigating",
        assignedUser: input.assignedUser || defaultUser,
        updated: "Just now",
      };

      setIncidents((prev) => {
        const updated = [newIncident, ...prev];
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        } catch {
          // ignore storage write errors
        }
        return updated;
      });

      setToastMessage(`Incident ${newId} created successfully.`);
      setTimeout(() => {
        setToastMessage((current) =>
          current === `Incident ${newId} created successfully.` ? null : current
        );
      }, 4000);

      return newIncident;
    },
    [incidents, getNextIncidentId]
  );

  const resetToMockData = useCallback(() => {
    setIncidents(MOCK_INCIDENTS);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  const openCreateModal = useCallback(() => setIsCreateModalOpen(true), []);
  const closeCreateModal = useCallback(() => setIsCreateModalOpen(false), []);

  const openCount = useMemo(
    () => incidents.filter((incident) => incident.status !== "Resolved").length,
    [incidents]
  );

  const criticalCount = useMemo(
    () =>
      incidents.filter(
        (incident) =>
          incident.severity === "Critical" && incident.status !== "Resolved"
      ).length,
    [incidents]
  );

  const value = useMemo(
    () => ({
      incidents,
      addIncident,
      openCount,
      criticalCount,
      isCreateModalOpen,
      openCreateModal,
      closeCreateModal,
      toastMessage,
      setToastMessage,
      resetToMockData,
    }),
    [
      incidents,
      addIncident,
      openCount,
      criticalCount,
      isCreateModalOpen,
      openCreateModal,
      closeCreateModal,
      toastMessage,
      resetToMockData,
    ]
  );

  return (
    <IncidentContext.Provider value={value}>
      {children}
    </IncidentContext.Provider>
  );
}

export function useIncidentContext(): IncidentContextType {
  const context = useContext(IncidentContext);
  if (!context) {
    throw new Error(
      "useIncidentContext must be used within an IncidentProvider"
    );
  }
  return context;
}

