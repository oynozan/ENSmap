// @vitest-environment jsdom
import type { GraphNode } from '@ensmap/core/schema';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeList } from './NodeList.tsx';

afterEach(cleanup);

function node(id: string, label: string): GraphNode {
  return {
    id,
    kind: 'subname',
    label,
    tags: [],
    size: { metric: 'subnamesHeld', value: 0 },
  };
}

const NODES = [node('a', 'a.eth'), node('b', 'b.a.eth')];

describe('NodeList', () => {
  it('lists every node as a button inside the labelled nav', () => {
    render(<NodeList nodes={NODES} onFocusNode={vi.fn()} onSelect={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: 'Names on the map' });
    expect(
      [...nav.querySelectorAll('button')].map((b) => b.textContent),
    ).toEqual(['a.eth', 'b.a.eth']);
  });

  it('reports focus and blur, and selects on Enter', async () => {
    const onFocusNode = vi.fn();
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <NodeList nodes={NODES} onFocusNode={onFocusNode} onSelect={onSelect} />,
    );

    act(() => {
      screen.getByRole('button', { name: 'a.eth' }).focus();
    });
    expect(onFocusNode).toHaveBeenLastCalledWith('a');

    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('a');

    await user.tab();
    expect(onFocusNode.mock.calls.slice(-2)).toEqual([[null], ['b']]);
  });
});
