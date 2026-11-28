import type { AggregateResult, AggregateRow } from '../core/types';
import { BOM, FLUSH_CHARS, csvLine, streamText } from './csv';

const CHANGE_TYPE: Record<AggregateRow['kind'], string> = {
  changed: 'differs',
  removed: 'only_left',
  added: 'only_right',
};

/** Streams the group rows as CSV: UTF-8 BOM, header, then one line per group. */
export async function writeAggregateCsv(result: AggregateResult, out: NodeJS.WritableStream): Promise<void> {
  await streamText(out, async (writeText) => {
    const targets = result.plan.targets;
    const header = [
      'change_type',
      ...result.plan.groups.map((g) => g.label),
      ...targets.flatMap((t) => [`${t.label} left`, `${t.label} right`, `${t.label} diff`]),
    ];
    let buf = BOM + csvLine(header);
    for (const row of result.rows) {
      buf += csvLine([
        CHANGE_TYPE[row.kind],
        ...row.group,
        ...targets.flatMap((_, i) => [row.left[i], row.right[i], row.diff[i]]),
      ]);
      if (buf.length >= FLUSH_CHARS) {
        const chunk = buf;
        buf = '';
        await writeText(chunk);
      }
    }
    if (buf) await writeText(buf);
  });
}

/** Message shown after a successful export. */
export function aggregateExportMessage(result: AggregateResult): string {
  const shown = result.rows.length;
  if (!result.detailCapped) return `Exported ${shown} groups.`;
  const total = result.changed + result.added + result.removed;
  return `Exported ${shown} groups (first ${shown} of ${total} differences).`;
}
