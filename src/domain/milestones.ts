export function eligibleMilestones(orderCount: number, n: number): number {
  return Math.floor(orderCount / n);
}

export function nextUnrewardedMilestone(
  orderCount: number,
  n: number,
  generatedMilestones: number[],
): number | null {
  const eligible = eligibleMilestones(orderCount, n);
  const generated = new Set(generatedMilestones);
  for (let milestone = 1; milestone <= eligible; milestone++) {
    if (!generated.has(milestone)) {
      return milestone;
    }
  }
  return null;
}
