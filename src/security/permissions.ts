import type { Risk, Tool } from '../tools/registry.ts';

export interface ApprovalRequest {
  tool: string;
  risk: Risk;
  target: string;
  detail?: string;
}
export type Approver = (req: ApprovalRequest, signal: AbortSignal) => Promise<boolean>;

export const riskOf = (tool: Tool, args: unknown): Risk => (typeof tool.risk === 'function' ? tool.risk(args) : tool.risk);

/** The only gate. Low risk passes; anything else needs an explicit `true` from the human-facing approver. No approver = no. */
export async function authorize(req: ApprovalRequest, approve: Approver | undefined, signal: AbortSignal): Promise<boolean> {
  if (req.risk === 'low') return true;
  if (!approve) return false;
  try {
    return (await approve(req, signal)) === true;
  } catch {
    return false;
  }
}
