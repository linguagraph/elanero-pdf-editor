// The first-load size budget (W1.1 section 9, docs/web/plan.md decision 10): the app's files, as
// they travel compressed, must stay within the budget. The size is the sum of each file's gzip
// size, which is what the wire carries when the server compresses it. Pure, so the build script
// (scripts/check-size.ts) and the tests share it.

// 40 MB compressed. The plan's 40 MB is decimal, so the stricter reading is used.
export const GZIP_BUDGET_BYTES = 40_000_000;

export interface SizedFile {
  path: string;
  gzipBytes: number;
}

export interface BudgetResult {
  totalBytes: number;
  budgetBytes: number;
  withinBudget: boolean;
}

export function checkGzipBudget(
  files: readonly SizedFile[],
  budgetBytes: number = GZIP_BUDGET_BYTES,
): BudgetResult {
  const totalBytes = files.reduce((sum, file) => sum + file.gzipBytes, 0);
  return { totalBytes, budgetBytes, withinBudget: totalBytes <= budgetBytes };
}
