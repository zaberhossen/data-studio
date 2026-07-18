"use client";

/** Audit route (`/audit`) — read-only org security audit log (admins/owners). */

import { AuditLogView } from "@/components/audit/AuditLogView";

export default function AuditPage() {
  return <AuditLogView />;
}
