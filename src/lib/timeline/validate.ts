import type { AssetMeta, Insertion } from './types';

export type IssueLevel = 'error' | 'warning';

export interface Issue {
  level: IssueLevel;
  code:
    | 'missing-clip'
    | 'empty-trim'
    | 'trim-out-of-range'
    | 'cut-out-of-range'
    | 'duplicate-insertion'
    | 'main-too-short';
  message: string;
  insertionId?: string;
}

const EPS = 1e-6;

export function validateInsertions(
  main: AssetMeta | null,
  clips: ReadonlyMap<string, AssetMeta>,
  insertions: readonly Insertion[],
): Issue[] {
  const issues: Issue[] = [];
  if (!main) return issues;

  if (main.duration <= 0) {
    issues.push({ level: 'error', code: 'main-too-short', message: 'The main video has no duration.' });
  }

  const seen = new Map<string, string>();

  for (const ins of insertions) {
    const clip = clips.get(ins.clipId);
    if (!clip) {
      issues.push({
        level: 'error',
        code: 'missing-clip',
        message: 'This clip was removed from the library.',
        insertionId: ins.id,
      });
      continue;
    }

    if (ins.snappedMainTime < -EPS || ins.snappedMainTime > main.duration + EPS) {
      issues.push({
        level: 'error',
        code: 'cut-out-of-range',
        message: 'The insert time is outside the main video.',
        insertionId: ins.id,
      });
    }

    if (ins.outPoint - ins.inPoint <= EPS) {
      issues.push({
        level: 'error',
        code: 'empty-trim',
        message: 'This clip is trimmed to zero length.',
        insertionId: ins.id,
      });
    }

    if (ins.inPoint < -EPS || ins.outPoint > clip.duration + EPS) {
      issues.push({
        level: 'warning',
        code: 'trim-out-of-range',
        message: 'The trim extends past the clip; it will be clamped.',
        insertionId: ins.id,
      });
    }

    const key = `${ins.clipId}@${ins.snappedMainTime.toFixed(3)}`;
    const prev = seen.get(key);
    if (prev) {
      issues.push({
        level: 'warning',
        code: 'duplicate-insertion',
        message: 'The same clip is inserted twice at this exact cut.',
        insertionId: ins.id,
      });
    }
    seen.set(key, ins.id);
  }

  return issues;
}

export function hasErrors(issues: readonly Issue[]): boolean {
  return issues.some((i) => i.level === 'error');
}
