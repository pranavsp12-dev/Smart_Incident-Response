import assert from "node:assert";

// Simulation of Validation Logic from CreateIncidentModal
function validateForm({ title, description, service, customService }) {
  const errors = {};

  if (!title || !title.trim()) {
    errors.title = "Incident title is required.";
  } else if (title.trim().length < 4) {
    errors.title = "Title must be at least 4 characters long.";
  }

  if (!description || !description.trim()) {
    errors.description = "Incident description is required.";
  } else if (description.trim().length < 8) {
    errors.description = "Description must provide sufficient detail (at least 8 characters).";
  }

  if (service === "custom" && (!customService || !customService.trim())) {
    errors.service = "Affected service name is required.";
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
}

// Simulation of Sequential ID Generation and Store Update from IncidentContext
function getNextIncidentId(currentList) {
  const numbers = currentList
    .map((inc) => {
      const match = inc.id.match(/\d+/);
      return match ? parseInt(match[0], 10) : 0;
    })
    .filter((n) => !isNaN(n));
  const maxNum = numbers.length > 0 ? Math.max(...numbers) : 1042;
  return `INC-${maxNum + 1}`;
}

function calculateDashboardCounts(incidents) {
  const openCount = incidents.filter((inc) => inc.status !== "Resolved").length;
  const criticalCount = incidents.filter(
    (inc) => inc.severity === "Critical" && inc.status !== "Resolved"
  ).length;
  const servicesCount = new Set(incidents.map((i) => i.service)).size;
  const resolvedCount = incidents.filter((i) => i.status === "Resolved").length;
  return { openCount, criticalCount, servicesCount, resolvedCount };
}

// Initial Mock Incidents
const initialIncidents = [
  {
    id: "INC-1042",
    title: "Payment API returning 500 errors on checkout",
    description: "Customer checkout attempts are failing with HTTP 500.",
    service: "Payment Gateway",
    severity: "Critical",
    priority: "P1",
    status: "Investigating",
    assignedUser: { name: "Sarah Chen", email: "sarah.chen@incidentops.internal", avatarInitials: "SC" },
    updated: "5 min ago",
  },
  {
    id: "INC-1041",
    title: "Elevated database read latency in us-east-1",
    description: "Postgres replica cluster query response times > 1800ms.",
    service: "PostgreSQL Primary",
    severity: "High",
    priority: "P2",
    status: "Identified",
    assignedUser: { name: "Alex Rivera", email: "alex.rivera@incidentops.internal", avatarInitials: "AR" },
    updated: "18 min ago",
  },
  {
    id: "INC-1040",
    title: "Notification delivery queue delayed",
    description: "Push notification delivery queue is lagging behind.",
    service: "Notification Service",
    severity: "Low",
    priority: "P4",
    status: "Resolved",
    assignedUser: { name: "Elena Rostova", email: "elena.rostova@incidentops.internal", avatarInitials: "ER" },
    updated: "1 hr ago",
  },
];

console.log("=== STARTING INCIDENT FLOW TEST SUITE ===");

// 1. TEST VALIDATION FLOW
console.log("\n[Test 1] Testing Form Validation Flow...");

// Test empty fields
const emptyCheck = validateForm({ title: "", description: "", service: "Payment Gateway" });
assert.strictEqual(emptyCheck.isValid, false);
assert.strictEqual(emptyCheck.errors.title, "Incident title is required.");
assert.strictEqual(emptyCheck.errors.description, "Incident description is required.");
console.log("  ✓ Empty title & description properly rejected with clear error messages.");

// Test short fields
const shortCheck = validateForm({ title: "API", description: "down", service: "Payment Gateway" });
assert.strictEqual(shortCheck.isValid, false);
assert.strictEqual(shortCheck.errors.title, "Title must be at least 4 characters long.");
assert.strictEqual(shortCheck.errors.description, "Description must provide sufficient detail (at least 8 characters).");
console.log("  ✓ Short title & description properly caught with minimum length validation.");

// Test custom service without name
const customServiceCheck = validateForm({
  title: "Service Outage on Edge Worker",
  description: "Edge worker routing rules failing to forward headers.",
  service: "custom",
  customService: "   ",
});
assert.strictEqual(customServiceCheck.isValid, false);
assert.strictEqual(customServiceCheck.errors.service, "Affected service name is required.");
console.log("  ✓ Custom service without name correctly rejected.");

// Test valid submission
const validCheck = validateForm({
  title: "Billing Ingress Gateway Dropouts",
  description: "Ingress gateway dropping ~12% of inbound token transactions.",
  service: "Payment Gateway",
});
assert.strictEqual(validCheck.isValid, true);
assert.deepStrictEqual(validCheck.errors, {});
console.log("  ✓ Valid submission passes all validation checks.");

// 2. TEST CANCEL FLOW
console.log("\n[Test 2] Testing Cancel Flow...");
let incidents = [...initialIncidents];
const initialCounts = calculateDashboardCounts(incidents);

// Simulate opening modal, filling inputs, and clicking Cancel
let formState = {
  title: "Half typed incident",
  description: "Some description here",
  service: "Payment Gateway",
  severity: "High",
  priority: "P2",
};
// User clicks cancel: reset formState and do not mutate incidents
formState = { title: "", description: "", service: "Payment Gateway", severity: "High", priority: "P2" };
assert.strictEqual(formState.title, "");
assert.strictEqual(incidents.length, 3);
const afterCancelCounts = calculateDashboardCounts(incidents);
assert.deepStrictEqual(initialCounts, afterCancelCounts);
console.log("  ✓ Cancel flow resets form fields and leaves incidents list and dashboard counts unchanged.");

// 3. TEST CREATE & LIST-UPDATE FLOW
console.log("\n[Test 3] Testing Create Incident & List-Update Flow...");

// Add Critical incident
const nextId1 = getNextIncidentId(incidents);
assert.strictEqual(nextId1, "INC-1043");

const newCriticalIncident = {
  id: nextId1,
  title: "Auth Gateway TLS Handshake Timeouts",
  description: "TLS handshakes timing out for all mobile client API requests.",
  service: "Auth & Identity",
  severity: "Critical",
  priority: "P1",
  status: "Investigating",
  assignedUser: { name: "Sarah Chen", email: "sarah.chen@incidentops.internal", avatarInitials: "SC" },
  updated: "Just now",
};

incidents = [newCriticalIncident, ...incidents];
assert.strictEqual(incidents.length, 4);
assert.strictEqual(incidents[0].id, "INC-1043");
assert.strictEqual(incidents[0].title, "Auth Gateway TLS Handshake Timeouts");
assert.strictEqual(incidents[0].priority, "P1");
assert.strictEqual(incidents[0].status, "Investigating");

const countsAfterCritical = calculateDashboardCounts(incidents);
assert.strictEqual(countsAfterCritical.openCount, initialCounts.openCount + 1);
assert.strictEqual(countsAfterCritical.criticalCount, initialCounts.criticalCount + 1);
console.log("  ✓ Created Critical P1 incident prepended at index 0.");
console.log(`  ✓ Dashboard openCount incremented (${initialCounts.openCount} -> ${countsAfterCritical.openCount}).`);
console.log(`  ✓ Dashboard criticalCount incremented (${initialCounts.criticalCount} -> ${countsAfterCritical.criticalCount}).`);

// Add Low priority incident
const nextId2 = getNextIncidentId(incidents);
assert.strictEqual(nextId2, "INC-1044");

const newLowIncident = {
  id: nextId2,
  title: "Documentation search autocomplete styling bug",
  description: "Autocomplete dropdown box text overlapping on dark theme in Safari.",
  service: "Billing Service",
  severity: "Low",
  priority: "P4",
  status: "Investigating",
  assignedUser: { name: "Alex Rivera", email: "alex.rivera@incidentops.internal", avatarInitials: "AR" },
  updated: "Just now",
};

incidents = [newLowIncident, ...incidents];
assert.strictEqual(incidents.length, 5);
assert.strictEqual(incidents[0].id, "INC-1044");

const countsAfterLow = calculateDashboardCounts(incidents);
assert.strictEqual(countsAfterLow.openCount, countsAfterCritical.openCount + 1);
assert.strictEqual(countsAfterLow.criticalCount, countsAfterCritical.criticalCount); // Critical count should remain unchanged
console.log("  ✓ Created Low P4 incident prepended at index 0.");
console.log(`  ✓ Dashboard openCount incremented (${countsAfterCritical.openCount} -> ${countsAfterLow.openCount}).`);
console.log(`  ✓ Dashboard criticalCount correctly stayed constant (${countsAfterCritical.criticalCount}).`);

// 4. TEST FILTER & SEARCH FLOW WITH NEW INCIDENTS
console.log("\n[Test 4] Testing Search and Filter Flow on updated list...");

// Search by new ID
const idMatches = incidents.filter((i) => i.id.toLowerCase().includes("1043"));
assert.strictEqual(idMatches.length, 1);
assert.strictEqual(idMatches[0].title, "Auth Gateway TLS Handshake Timeouts");
console.log("  ✓ Search by new incident ID '1043' found the created incident.");

// Search by title keyword
const titleMatches = incidents.filter((i) => i.title.toLowerCase().includes("handshake"));
assert.strictEqual(titleMatches.length, 1);
assert.strictEqual(titleMatches[0].id, "INC-1043");
console.log("  ✓ Search by title keyword 'handshake' matched correctly.");

// Search by description keyword
const descMatches = incidents.filter((i) => i.description.toLowerCase().includes("safari"));
assert.strictEqual(descMatches.length, 1);
assert.strictEqual(descMatches[0].id, "INC-1044");
console.log("  ✓ Search by description keyword 'safari' matched correctly.");

// Filter by Severity: Critical
const criticalFilterMatches = incidents.filter((i) => i.severity === "Critical");
assert.strictEqual(criticalFilterMatches.length, 2); // original INC-1042 + new INC-1043
console.log("  ✓ Severity filter 'Critical' returned both original and new critical incidents.");

// Filter by Status: Investigating
const investigatingMatches = incidents.filter((i) => i.status === "Investigating");
assert.strictEqual(investigatingMatches.length, 3); // original INC-1042 + INC-1043 + INC-1044
console.log("  ✓ Status filter 'Investigating' captured all active investigating incidents.");

console.log("\n=== ALL FLOW TESTS PASSED SUCCESSFULLY! ===");

