/**
 * A repair crew's branch is `repair/<signal id>` and, for later attempts, `repair/<id>-<n>`. A pull
 * request from a branch that starts so is a repair's, whoever asks to merge it, so what decides
 * is the branch the host reports, not a thread. Case-blind, since a host may fold case.
 */
const REPAIR_BRANCH_PREFIX = /^repair\//iu;

export const isRepairBranch = (branch: string) => REPAIR_BRANCH_PREFIX.test(branch);

/** The branch of attempt `attempt` of the repair for `signalId`. */
export const repairBranchOf = (signalId: string, attempt: number) =>
  `repair/${signalId}${attempt === 1 ? "" : `-${attempt}`}`;

/** The signal id a repair branch's name carries, if it is exactly one a repair would make. */
export const signalOfRepairBranch = (branch: string) =>
  /^repair\/([0-9a-f]{12})(?:-[1-9][0-9]*)?$/u.exec(branch)?.[1];
