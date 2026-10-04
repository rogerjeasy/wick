/** Test-only: a ToolContext for a member the resident has already allowed. */
import type { ToolContext } from '../context.js';

export function allowedContext(householdId: string, member: { userId?: string; name?: string } = {}): ToolContext {
  const userId = member.userId ?? 'u_sarah';
  return {
    householdId,
    userId,
    access: async () => ({
      ok: true,
      membership: { householdId, userId, name: member.name ?? 'Sarah', role: 'organiser', status: 'allowed', requestedAt: 0 },
      household: { householdId, name: 'Margaret’s home', residentName: 'Margaret', createdBy: userId, createdAt: 0 },
    }),
  };
}
