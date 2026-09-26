// @vitest-environment jsdom
import type { GraphMeta } from '@ensmap/core/schema';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StatusLine } from './StatusLine.tsx';

afterEach(cleanup);

function meta(overrides: Partial<GraphMeta> = {}): GraphMeta {
  return {
    namespace: 'sepolia-v2',
    root: '0xroot',
    computedAt: '2026-09-26T00:00:00.000Z',
    caps: { fetch: 1000 },
    filters: {},
    totals: { names: 6, indexed: { value: 6, exact: true }, wallets: 2 },
    truncated: [],
    warnings: [],
    ...overrides,
  };
}

describe('StatusLine', () => {
  it('shows the exact counts', () => {
    render(<StatusLine meta={meta()} />);
    expect(screen.getByText('6 names · indexed 6 · sepolia-v2')).toBeTruthy();
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('marks an inexact indexed count with ≥', () => {
    const totals = {
      names: 1000,
      indexed: { value: 1000, exact: false },
      wallets: 3,
    };
    render(<StatusLine meta={meta({ totals, truncated: ['names'] })} />);
    expect(
      screen.getByText('1000 names · indexed ≥1000 · sepolia-v2 · truncated'),
    ).toBeTruthy();
  });

  it('uses the singular for a lone root', () => {
    const totals = { names: 1, indexed: { value: 1, exact: true }, wallets: 0 };
    render(<StatusLine meta={meta({ totals })} />);
    expect(screen.getByText('1 name · indexed 1 · sepolia-v2')).toBeTruthy();
  });

  it('summarises one warning', () => {
    render(<StatusLine meta={meta({ warnings: ['alias unresolved'] })} />);
    expect(screen.getByText('1 warning').tagName).toBe('SUMMARY');
    expect(screen.getByText('alias unresolved').tagName).toBe('LI');
  });

  it('summarises several warnings', () => {
    render(<StatusLine meta={meta({ warnings: ['first', 'second'] })} />);
    expect(screen.getByText('2 warnings').tagName).toBe('SUMMARY');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(
      ['first', 'second'],
    );
  });
});
