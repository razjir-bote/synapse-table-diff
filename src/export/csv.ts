import { finished } from 'node:stream/promises';
import type { CompareResult, DiffRow } from '../core/types';

export const BOM = '\uFEFF';
const FLUSH_CHARS = 64 * 1024;

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Spreadsheet apps run cells that start with = + - @ (or a tab/CR) as formulas, so a
 * value from the database could trigger a formula or DDE payload when the CSV is opened.
 * Such values get a leading apostrophe; plain numbers like -5 or +1.5e3 are left as they are.
 */
export function neutralizeFormula(v: string): string {
  return FORMULA_START.test(v) && !PLAIN_NUMBER.test(v) ? "'" + v : v;
}

/** RFC 4180 field quoting; null becomes an empty field. */
function field(v: string | null | undefined): string {
  if (v === null || v === undefined) return '';
  v = neutralizeFormula(v);
  if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

export function csvLine(fields: (string | null | undefined)[]): string {
  return fields.map(field).join(',') + '\r\n';
}

function csvRow(result: CompareResult, row: DiffRow): string {
  const keys = result.plan.keys.map((_, i) => row.key[i]);
  const cols = result.plan.compared.flatMap((_, i) => [row.left?.[i], row.right?.[i]]);
  return csvLine([row.kind, ...keys, ...cols]);
}

/**
 * Streams the detail rows as CSV: UTF-8 BOM, header, then one line per row.
 * Ends the stream and resolves once it has finished writing. Rejects with the
 * stream's error if it fails at any point, including mid-stream and before finish.
 */
export async function writeCsv(result: CompareResult, out: NodeJS.WritableStream): Promise<void> {
  // One persistent error listener for the whole run, so a stream error is never
  // unhandled. It records the first error and wakes any pending wait.
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  const onError = (err: Error) => {
    failure ??= err;
    wake?.();
  };
  out.on('error', onError);

  const check = () => {
    if (failure) throw failure;
  };

  const waitForDrain = () =>
    new Promise<void>((resolve) => {
      if (failure) return resolve();
      const done = () => {
        wake = undefined;
        resolve();
      };
      wake = () => {
        out.removeListener('drain', done);
        done();
      };
      out.once('drain', done);
    });

  const writeText = async (text: string) => {
    check();
    if (!out.write(text)) await waitForDrain();
    check();
  };

  try {
    const header = [
      'change_type',
      ...result.plan.keys.map((k) => k.name),
      ...result.plan.compared.flatMap((c) => [`left_${c.name}`, `right_${c.name}`]),
    ];
    let buf = BOM + csvLine(header);
    for (const row of result.rows) {
      buf += csvRow(result, row);
      if (buf.length >= FLUSH_CHARS) {
        const chunk = buf;
        buf = '';
        await writeText(chunk);
      }
    }
    if (buf) await writeText(buf);
    out.end();
    await finished(out as unknown as import('node:stream').Writable);
    check();
  } finally {
    out.removeListener('error', onError);
  }
}

/** Message shown after a successful export. */
export function exportMessage(result: CompareResult): string {
  const shown = result.rows.length;
  if (!result.detailCapped) return `Exported ${shown} rows.`;
  const total = result.added + result.removed + result.changed;
  return `Exported ${shown} rows (first ${shown} of ${total} differences).`;
}
