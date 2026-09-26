// @vitest-environment jsdom
import type { GraphNode } from '@ensmap/core/schema';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DetailsPanel } from './DetailsPanel.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const WALLET = '0x1111111111111111111111111111111111111111';
const OWNER = '0x2222222222222222222222222222222222222222';

function node(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    kind: 'subname',
    label: `${overrides.id}.eth`,
    tags: [],
    size: { metric: 'subnamesHeld', value: 0 },
    ...overrides,
  };
}

const HOME = node({
  id: 'home',
  kind: 'name',
  label: 'seller-a.eth',
  address: WALLET,
  verified: true,
  verifiedBy: 'primary-name',
  names: ['home', 'agent', 'obs'],
  homeName: 'home',
});
const AGENT = node({
  id: 'agent',
  label: 'agent-1.seller-a.eth',
  address: WALLET,
  verified: true,
  verifiedBy: 'owner',
  owner: OWNER,
  names: ['home', 'agent', 'obs'],
  homeName: 'home',
  tags: ['expired'],
});
const OBS = node({
  id: 'obs',
  label: 'obs.seller-a.eth',
  canonical: 'obs.vet402.eth',
  sharedWith: ['vet402.eth', 'other.eth'],
  tags: ['alias-path', 'alias-unresolved'],
});
const UNVERIFIED = node({
  id: 'loose',
  label: 'loose.seller-a.eth',
  address: WALLET,
  verified: false,
  names: ['loose'],
  homeName: 'loose',
});

const BY_ID: ReadonlyMap<string, GraphNode> = new Map(
  [HOME, AGENT, OBS, UNVERIFIED].map((n) => [n.id, n]),
);

function renderPanel(
  shown: GraphNode,
  handlers: { onSelect?: (id: string) => void; onClose?: () => void } = {},
) {
  return render(
    <DetailsPanel
      node={shown}
      nodesById={BY_ID}
      onSelect={handlers.onSelect ?? vi.fn()}
      onClose={handlers.onClose ?? vi.fn()}
    />,
  );
}

function panel(): HTMLElement {
  return screen.getByRole('complementary', { name: 'Name details' });
}

function rowLabels(): string[] {
  return [...panel().querySelectorAll('dt')].map((dt) => dt.textContent);
}

function rowValue(label: string): HTMLElement {
  const dt = [...panel().querySelectorAll('dt')].find(
    (el) => el.textContent === label,
  );
  const dd = dt?.nextElementSibling;
  if (!(dd instanceof HTMLElement)) {
    throw new Error(`no row ${label}`);
  }
  return dd;
}

describe('DetailsPanel', () => {
  it('shows a verified-by-owner wallet with its owner', () => {
    renderPanel(AGENT);
    expect(
      screen.getByRole('heading', { level: 2, name: 'agent-1.seller-a.eth' }),
    ).toBeTruthy();
    expect(within(rowValue('Wallet')).getByText(WALLET)).toBeTruthy();
    expect(screen.getByText('verified by owner')).toBeTruthy();
    expect(rowValue('Owner').textContent).toBe(OWNER);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(rowValue('Tags').textContent).toBe('expired');
    expect(rowLabels()).toEqual(['Wallet', 'Owner', 'Same wallet', 'Tags']);
  });

  it('shows the primary-name and unverified statuses', () => {
    const { unmount } = renderPanel(HOME);
    expect(screen.getByText('verified by primary name')).toBeTruthy();
    expect(rowValue('Owner').textContent).toBe('—');
    unmount();
    renderPanel(UNVERIFIED);
    expect(screen.getByText('unverified')).toBeTruthy();
    expect(rowLabels()).toEqual(['Wallet', 'Owner']);
  });

  it('selects another name on the same wallet', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    renderPanel(AGENT, { onSelect });
    const others = within(rowValue('Same wallet')).getAllByRole('button');
    expect(others.map((b) => b.textContent)).toEqual([
      'seller-a.eth',
      'obs.seller-a.eth',
    ]);
    await user.click(
      within(rowValue('Same wallet')).getByRole('button', {
        name: 'seller-a.eth',
      }),
    );
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('home');
  });

  it('focuses its heading on open and keeps focus there across Same wallet', async () => {
    function Harness() {
      const [id, setId] = useState('agent');
      return (
        <DetailsPanel
          node={BY_ID.get(id) ?? AGENT}
          nodesById={BY_ID}
          onSelect={setId}
          onClose={vi.fn()}
        />
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 2, name: 'agent-1.seller-a.eth' }),
    );

    act(() => {
      within(rowValue('Same wallet'))
        .getByRole('button', { name: 'obs.seller-a.eth' })
        .focus();
    });
    await user.keyboard('{Enter}');

    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 2, name: 'obs.seller-a.eth' }),
    );
  });

  it('closes on Escape and on the close button', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderPanel(AGENT, { onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Close details' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('shows no wallet and no Copy button without an address', () => {
    renderPanel(OBS);
    expect(screen.getByText('no wallet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(rowLabels()).toEqual([
      'Owner',
      'Canonical',
      'Registry shared with',
      'Tags',
    ]);
  });

  it('shows Canonical and Registry shared with only when set', () => {
    const { unmount } = renderPanel(OBS);
    expect(rowValue('Canonical').textContent).toBe('obs.vet402.eth');
    expect(
      within(rowValue('Registry shared with'))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['vet402.eth', 'other.eth']);
    unmount();
    renderPanel(HOME);
    expect(rowLabels()).not.toContain('Canonical');
    expect(rowLabels()).not.toContain('Registry shared with');
  });

  it('copies the address and reads Copied for 1.5 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({
      advanceTimers: (ms) => vi.advanceTimersByTime(ms),
    });
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined);
    renderPanel(AGENT);
    // The async act flushes the effect that starts the 1.5 s timer before the
    // clock is advanced; without it that effect can run too late under load.
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(WALLET);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });
});
