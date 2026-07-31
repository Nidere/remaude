// Data adapter for the limits widget. The single place that knows about the
// unstable shape of the experimental usage API — when the SDK changes, fix it here.

/**
 * @returns {{fiveHour: {utilization:number|null, resetsAt:string|null}|null,
 *            sevenDay: {utilization:number|null, resetsAt:string|null}|null,
 *            modelScoped: {name:string, utilization:number|null, resetsAt:string|null}[],
 *            subscription: string|null} | null}
 */
export function extractLimits(rawUsage) {
  const rl = rawUsage?.rate_limits;
  if (!rawUsage?.rate_limits_available || !rl) return null;
  const window = (w) => (w ? { utilization: w.utilization ?? null, resetsAt: w.resets_at ?? null } : null);
  return {
    fiveHour: window(rl.five_hour),
    sevenDay: window(rl.seven_day),
    modelScoped: (rl.model_scoped ?? []).map((m) => ({
      name: m.display_name,
      utilization: m.utilization ?? null,
      resetsAt: m.resets_at ?? null,
    })),
    subscription: rawUsage.subscription_type ?? null,
  };
}
