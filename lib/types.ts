export type Severity = "Critical" | "High" | "Medium" | "Low";

export type Priority = "P1" | "P2" | "P3" | "P4";

export type Status = "Investigating" | "Identified" | "Monitoring" | "Resolved";

export interface AssignedUser {
  name: string;
  email: string;
  avatarInitials: string;
}

export interface Incident {
  id: string;
  title: string;
  description: string;
  service: string;
  severity: Severity;
  priority: Priority;
  status: Status;
  assignedUser: AssignedUser;
  updated: string;
}

export interface CreateIncidentInput {
  title: string;
  description: string;
  service: string;
  severity: Severity;
  priority: Priority;
  assignedUser?: AssignedUser;
}
