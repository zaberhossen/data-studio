/**
 * Onboarding checklist state — pure helpers shared by the home checklist and its
 * tests. The four milestones latch: once a step is completed it stays completed
 * even if the underlying entity is later deleted (a milestone is an achievement,
 * not a live status), so the merge is a monotonic OR against the persisted state.
 */

export type OnboardingStepId = "source" | "query" | "dashboard" | "share";

export const ONBOARDING_STEPS: readonly OnboardingStepId[] = [
  "source",
  "query",
  "dashboard",
  "share",
];

export type OnboardingState = Record<OnboardingStepId, boolean>;

export const EMPTY_ONBOARDING: OnboardingState = {
  source: false,
  query: false,
  dashboard: false,
  share: false,
};

/** Monotonic OR: a step true in EITHER the persisted or the live set stays true. */
export function mergeOnboarding(
  prev: Partial<OnboardingState> | null | undefined,
  live: Partial<OnboardingState>,
): OnboardingState {
  const out = { ...EMPTY_ONBOARDING };
  for (const step of ONBOARDING_STEPS) {
    out[step] = Boolean(prev?.[step]) || Boolean(live[step]);
  }
  return out;
}

export function completedCount(state: OnboardingState): number {
  return ONBOARDING_STEPS.reduce((n, s) => n + (state[s] ? 1 : 0), 0);
}

export function isComplete(state: OnboardingState): boolean {
  return completedCount(state) === ONBOARDING_STEPS.length;
}
