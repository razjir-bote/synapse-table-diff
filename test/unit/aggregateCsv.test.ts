import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import type { AggregateResult } from '../../src/core/types';
import { writeAggregateCsv, aggregateExportMessage } from '../../src/export/aggregateCsv';

const result = {
  mode: 'aggregate',
  plan: {
    groups: [{ label: 'region' }, { label: 'cust ↔ customer' }],
    targets: [{ label: 'Rows' }, { label: 'amount · sum' }],
  },
  rows: [
    { kind: 'changed', group: ['=1+1', 'a'], left: ['5', '10.50'], right: ['6', '11.00'], diff: ['1', '0.50'], differs: [true, true] },
    { kind: 'removed', group: ['N', null], left: ['2', null], right: [null, null], diff: [null, null], differs: [false, false] },
    { kind: 'added', group: ['S', 'b'], left: [null, null], right: ['3', '7'], diff: [null, null], differs: [false, false] },
  ],
} as unknown as AggregateResult;

async function collect(r: AggregateResult): Promise<string> {
  const chunks: Buffer[] = [];
  const out = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  await writeAggregateCsv(r, out);
  return Buffer.concat(chunks).toString('utf8');
}

describe('writeAggregateCsv', () => {
  it('writes BOM, header and one row of each kind', async () => {
    const text = await collect(result);
    expect(text.startsWith('﻿')).toBe(true);
    expect(text.slice(1).split('\r\n')).toEqual([
      'change_type,region,cust ↔ customer,Rows left,Rows right,Rows diff,amount · sum left,amount · sum right,amount · sum diff',
      "differs,'=1+1,a,5,6,1,10.50,11.00,0.50",
      'only_left,N,,2,,,,,',
      'only_right,S,b,,3,,,7,',
      '',
    ]);
  });

  it('rejects when the stream errors', async () => {
    const out = new Writable({ write(_c, _e, cb) { cb(new Error('disk full')); } });
    await expect(writeAggregateCsv(result, out)).rejects.toThrow('disk full');
  });
});

describe('aggregateExportMessage', () => {
  it('counts the exported groups', () => {
    expect(aggregateExportMessage(result)).toBe('Exported 3 groups.');
  });
});
