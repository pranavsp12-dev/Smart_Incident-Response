import { Incident } from "./types";

/**
 * ============================================================================
 * MOCK DATA - SMART INCIDENT RESPONSE PROTOTYPE
 * ============================================================================
 * Note: This data is static mock data used strictly for frontend demonstration
 * and UI testing. It is not connected to a backend API or persistent database.
 * ============================================================================
 */
export const MOCK_INCIDENTS: Incident[] = [
  {
    id: "INC-1042",
    title: "Payment API returning 500 errors on checkout",
    description: "Customer checkout attempts are failing with HTTP 500 downstream responses from payment processor webhooks.",
    service: "Payment Gateway",
    severity: "Critical",
    priority: "P1",
    status: "Investigating",
    assignedUser: {
      name: "Sarah Chen",
      email: "sarah.chen@incidentops.internal",
      avatarInitials: "SC",
    },
    updated: "5 min ago",
  },
  {
    id: "INC-1041",
    title: "Elevated database read latency in us-east-1",
    description: "Postgres replica cluster observing query response times > 1800ms due to unindexed partition scan on orders table.",
    service: "PostgreSQL Primary",
    severity: "High",
    priority: "P2",
    status: "Identified",
    assignedUser: {
      name: "Alex Rivera",
      email: "alex.rivera@incidentops.internal",
      avatarInitials: "AR",
    },
    updated: "18 min ago",
  },
  {
    id: "INC-1040",
    title: "Login requests timing out on OAuth provider",
    description: "Intermittent connection dropouts between our auth proxy and identity provider token validation endpoint.",
    service: "Auth & Identity",
    severity: "Medium",
    priority: "P3",
    status: "Monitoring",
    assignedUser: {
      name: "David Kim",
      email: "david.kim@incidentops.internal",
      avatarInitials: "DK",
    },
    updated: "42 min ago",
  },
  {
    id: "INC-1039",
    title: "Push notification delivery queue delayed",
    description: "APNs worker backlog accumulated ~45,000 notifications following worker node autoscale throttle limit.",
    service: "Notification Service",
    severity: "Low",
    priority: "P4",
    status: "Resolved",
    assignedUser: {
      name: "Elena Rostova",
      email: "elena.rostova@incidentops.internal",
      avatarInitials: "ER",
    },
    updated: "1 hr ago",
  },
  {
    id: "INC-1038",
    title: "Redis cache cluster high memory watermark > 92%",
    description: "Cache eviction rate increased rapidly; session keys not expiring due to missing TTL flag on batch ingestion.",
    service: "Caching Tier",
    severity: "High",
    priority: "P2",
    status: "Investigating",
    assignedUser: {
      name: "Marcus Vance",
      email: "marcus.vance@incidentops.internal",
      avatarInitials: "MV",
    },
    updated: "2 hrs ago",
  },
  {
    id: "INC-1037",
    title: "Third-party SMS webhook rate-limit triggered",
    description: "Marketing batch trigger exceeded vendor SMS quota, leading to 429 Too Many Requests responses.",
    service: "Messaging Gateway",
    severity: "Low",
    priority: "P4",
    status: "Resolved",
    assignedUser: {
      name: "Priya Patel",
      email: "priya.patel@incidentops.internal",
      avatarInitials: "PP",
    },
    updated: "3 hrs ago",
  },
  {
    id: "INC-1036",
    title: "Search index synchronization replica lag",
    description: "Elasticsearch replica shard sync falling behind primary by 34 minutes during bulk catalog reindexing.",
    service: "Elasticsearch Cluster",
    severity: "Medium",
    priority: "P3",
    status: "Identified",
    assignedUser: {
      name: "Jordan Taylor",
      email: "jordan.taylor@incidentops.internal",
      avatarInitials: "JT",
    },
    updated: "4 hrs ago",
  },
  {
    id: "INC-1035",
    title: "Cart checkout serialization deadlocks under peak load",
    description: "Concurrency locks in database isolation level caused rolling lock waits during flash promotion launch.",
    service: "Order Service",
    severity: "Critical",
    priority: "P1",
    status: "Resolved",
    assignedUser: {
      name: "Sarah Chen",
      email: "sarah.chen@incidentops.internal",
      avatarInitials: "SC",
    },
    updated: "6 hrs ago",
  },
  {
    id: "INC-1034",
    title: "SSL certificate renewal warning for internal RPC ingress",
    description: "Automated cert-manager renewal challenge failed due to strict firewall egress rule on internal Envoy gateway.",
    service: "API Gateway",
    severity: "Medium",
    priority: "P3",
    status: "Resolved",
    assignedUser: {
      name: "Alex Rivera",
      email: "alex.rivera@incidentops.internal",
      avatarInitials: "AR",
    },
    updated: "12 hrs ago",
  },
  {
    id: "INC-1033",
    title: "Billing invoice PDF generator worker memory leak",
    description: "Headless Chromium renderer process retained detached DOM nodes across high-volume monthly billing runs.",
    service: "Billing Service",
    severity: "Low",
    priority: "P4",
    status: "Monitoring",
    assignedUser: {
      name: "Unassigned",
      email: "unassigned@incidentops.internal",
      avatarInitials: "--",
    },
    updated: "1 day ago",
  },
];
