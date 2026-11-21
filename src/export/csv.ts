import type { CompareResult, DiffRow } from '../core/types';

const BOM = '﻿';
const FLUSH_CHARS = 64 * 1024;

/** RFC 4180 field quoting; null becomes an empty field. */
function field(v: string | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

function line(fields: (string | null | undefined)[]): string {
  return fields.map(field).join(',') + '\r\n';
}

function csvRow(result: CompareResult, row: DiffRow): string {
  const keys = result.plan.keys.map((_, i) => row.key[i]);
  const cols = result.plan.compared.flatMap((_, i) => [row.left?.[i], row.right?.[i]]);
  return line([row.kind, ...keys, ...cols]);
}

function writeChunk(out: NodeJS.WritableStream, text: string): Promise<void> {
  if (out.write(text)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      out.removeListener('error', onError);
      resolve();
    };
    const onError = (err: Error) => {
      out.removeListener('drain', onDrain);
      reject(err);
    };
    out.once('drain', onDrain);
    out.once('error', onError);
  });
}

/**
 * Streams the detail rows as CSV: UTF-8 BOM, header, then one line per row.
 * Ends the stream and resolves once it has finished writing.
 */
export async function writeCsv(result: CompareResult, out: NodeJS.WritableStream): Promise<void> {
  const header = [
    'change_type',
    ...result.plan.keys.map((k) => k.name),
    ...result.plan.compared.flatMap((c) => [`left_${c.name}`, `right_${c.name}`]),
  ];
  let buf = BOM + line(header);
  for (const row of result.rows) {
    buf += csvRow(result, row);
    if (buf.length >= FLUSH_CHARS) {
      const chunk = buf;
      buf = '';
      await writeChunk(out, chunk);
    }
  }
  if (buf) await writeChunk(out, buf);
  await new Promise<void>((resolve, reject) => {
    out.once('error', reject);
    out.once('finish', () => resolve());
    out.end();
  });
}

/** Message shown after a successful export. */
export function exportMessage(result: CompareResult): string {
  const shown = result.rows.length;
  if (!result.detailCapped) return `Exported ${shown} rows.`;
  const total = result.added + result.removed + result.changed;
  return `Exported ${shown} rows (first ${shown} of ${total} differences).`;
}
