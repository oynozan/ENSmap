// @vitest-environment jsdom
import type { Graph, GraphNode } from '@ensmap/core/schema';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.tsx';

vi.mock('./map/MapView.tsx', () => ({
  MapView: (props: { graph: Graph }) => (
    <div data-testid="map">{props.graph.nodes.length}</div>
  ),
}));

function node(id: string, label: string): GraphNode {
  return {
    id,
    kind: id === 'root' ? 'name' : 'subname',
    label,
    tags: [],
    size: { metric: 'subnamesHeld', value: 0 },
  };
}

// A root named `name` with `count - 1` subnames under it
function graphFor(name: string, count: number): Graph {
  const nodes = [
    node('root', name),
    ...Array.from({ length: count - 1 }, (_, i) =>
      node(`child-${i}`, `c${i}.${name}`),
    ),
  ];
  return {
    version: 1,
    nodes,
    edges: nodes.slice(1).map((child) => ({
      id: `subname:root:${child.id}`,
      source: 'root',
      target: child.id,
      kind: 'subname',
      directed: true,
    })),
    meta: {
      namespace: 'sepolia-v2',
      root: 'root',
      computedAt: '2026-09-26T00:00:00.000Z',
      caps: { fetch: 1000 },
      filters: {},
      totals: {
        names: count,
        indexed: { value: count, exact: true },
        wallets: 0,
      },
      truncated: [],
      warnings: [],
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const GRAPHS: Record<string, Graph> = {
  'gloomy.eth': graphFor('gloomy.eth', 5),
  'a.eth': graphFor('a.eth', 2),
  'b.eth': graphFor('b.eth', 3),
};

function urlOf(input: RequestInfo | URL | undefined): string {
  if (input instanceof Request) return input.url;
  return input instanceof URL ? input.href : (input ?? '');
}

function requestedName(input: RequestInfo | URL): string {
  const url = new URL(urlOf(input), 'http://localhost');
  return decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
}

// Serves GRAPHS by name and a 404 for anything else
const serveGraphs = vi.fn<typeof fetch>((input) => {
  const graph = GRAPHS[requestedName(input)];
  return Promise.resolve(
    graph === undefined
      ? json({ error: { code: 'not-found', message: 'x' } }, 404)
      : json(graph),
  );
});

function requestedNames(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) {
  return fetchMock.mock.calls.map(([input]) => requestedName(input));
}

// Answers each request only when the test calls respond(name, response)
function deferredFetch() {
  const pending = new Map<string, (response: Response) => void>();
  const fetchMock = vi.fn<typeof fetch>(
    (input) =>
      new Promise((resolve) => {
        pending.set(requestedName(input), resolve);
      }),
  );
  async function respond(name: string, response: Response) {
    await act(async () => {
      pending.get(name)?.(response);
      await Promise.resolve();
    });
  }
  return { fetchMock, respond };
}

function searchButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Search' });
}

const EMPTY_HINT = 'Search a name on the Sepolia ENSv2 Beta';

async function search(name: string) {
  const user = userEvent.setup();
  const input = screen.getByLabelText<HTMLInputElement>('ENS name');
  await user.clear(input);
  await user.type(input, `${name}{Enter}`);
}

beforeEach(() => {
  history.replaceState(null, '', '/');
  document.title = 'ENSmap';
  serveGraphs.mockClear();
  vi.stubGlobal('fetch', serveGraphs);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('shows the empty state and no map without a name', () => {
    render(<App />);
    expect(
      screen.getByText('Search a name on the Sepolia ENSv2 Beta'),
    ).toBeTruthy();
    expect(screen.queryByTestId('map')).toBeNull();
    expect(serveGraphs).not.toHaveBeenCalled();
  });

  it('loads ?name= on mount', async () => {
    history.replaceState(null, '', '/?name=gloomy.eth');
    render(<App />);

    expect((await screen.findByTestId('map')).textContent).toBe('5');
    expect(urlOf(serveGraphs.mock.calls[0]?.[0])).toContain('/gloomy.eth?');
    expect(screen.getByLabelText<HTMLInputElement>('ENS name').value).toBe(
      'gloomy.eth',
    );
    expect(document.title).toBe('gloomy.eth · ENSmap');
    expect(screen.queryByText('Search a name on the Sepolia ENSv2 Beta')).toBe(
      null,
    );
  });

  it('pushes ?name= on submit and re-runs on popstate', async () => {
    render(<App />);
    await search('a.eth');
    expect((await screen.findByTestId('map')).textContent).toBe('2');
    expect(location.search).toBe('?name=a.eth');

    await search('b.eth');
    await waitFor(() => {
      expect(screen.getByTestId('map').textContent).toBe('3');
    });
    expect(location.search).toBe('?name=b.eth');

    history.back();
    await waitFor(() => {
      expect(location.search).toBe('?name=a.eth');
    });
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('map').textContent).toBe('2');
    });
    expect(requestedNames(serveGraphs).at(-1)).toBe('a.eth');
    expect(screen.getByLabelText<HTMLInputElement>('ENS name').value).toBe(
      'a.eth',
    );
  });

  it('ignores a stale response', async () => {
    const pending = new Map<string, (response: Response) => void>();
    // Responds only when the test says so, and ignores aborts
    const deferred = vi.fn<typeof fetch>(
      (input) =>
        new Promise((resolve) => {
          pending.set(requestedName(input), resolve);
        }),
    );
    vi.stubGlobal('fetch', deferred);
    render(<App />);

    await search('a.eth');
    await search('b.eth');
    expect(requestedNames(deferred)).toEqual(['a.eth', 'b.eth']);

    await act(async () => {
      pending.get('b.eth')?.(json(GRAPHS['b.eth']));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId('map').textContent).toBe('3');
    });

    await act(async () => {
      pending.get('a.eth')?.(json(GRAPHS['a.eth']));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByTestId('map').textContent).toBe('3');
    expect(document.title).toBe('b.eth · ENSmap');
  });

  it('shows the error line and clears the map when a lookup fails', async () => {
    render(<App />);
    await search('a.eth');
    await screen.findByTestId('map');

    await search('missing.eth');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Name not found on the Sepolia ENSv2 Beta',
    );
    expect(screen.queryByTestId('map')).toBeNull();
    expect(
      screen.getByText('Search a name on the Sepolia ENSv2 Beta'),
    ).toBeTruthy();
    expect(document.title).toBe('ENSmap');
  });

  it('clears the map when Back returns to the page without a name', async () => {
    render(<App />);
    await search('a.eth');
    await screen.findByTestId('map');

    history.back();
    await waitFor(() => {
      expect(location.search).toBe('');
    });
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('map')).toBeNull();
    });
    expect(screen.getByLabelText<HTMLInputElement>('ENS name').value).toBe('');
  });

  it('opens the details panel from the node list and closes it on Escape', async () => {
    history.replaceState(null, '', '/?name=gloomy.eth');
    render(<App />);
    await screen.findByTestId('map');

    const list = screen.getByRole('navigation', { name: 'Names on the map' });
    const button = [...list.querySelectorAll('button')].find(
      (b) => b.textContent === 'c1.gloomy.eth',
    );
    expect(button).toBeDefined();
    fireEvent.click(button as HTMLButtonElement);

    const panel = screen.getByRole('complementary', { name: 'Name details' });
    expect(panel.querySelector('h2')?.textContent).toBe('c1.gloomy.eth');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(
      screen.queryByRole('complementary', { name: 'Name details' }),
    ).toBeNull();
  });

  it('stays busy during a lookup and hides the empty hint meanwhile', async () => {
    const { fetchMock, respond } = deferredFetch();
    vi.stubGlobal('fetch', fetchMock);
    history.replaceState(null, '', '/?name=a.eth');
    render(<App />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    expect(searchButton().getAttribute('aria-busy')).toBe('true');
    expect(searchButton().disabled).toBe(true);
    expect(screen.queryByText(EMPTY_HINT)).toBeNull();

    await respond('a.eth', json(GRAPHS['a.eth']));
    await screen.findByTestId('map');
    expect(searchButton().getAttribute('aria-busy')).toBe('false');
    expect(searchButton().disabled).toBe(false);
  });

  it('stops being busy and shows the error when a lookup fails', async () => {
    const { fetchMock, respond } = deferredFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    await search('a.eth');
    expect(searchButton().getAttribute('aria-busy')).toBe('true');

    await respond(
      'a.eth',
      json({ error: { code: 'provider-error', message: 'x' } }, 502),
    );
    expect((await screen.findByRole('alert')).textContent).toBe(
      'A data source is unavailable. Try again shortly.',
    );
    expect(searchButton().getAttribute('aria-busy')).toBe('false');
    expect(screen.getByText(EMPTY_HINT)).toBeTruthy();
  });

  it('searches where AbortSignal.any is missing', async () => {
    const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', {
      value: undefined,
      configurable: true,
    });
    try {
      render(<App />);
      await search('a.eth');
      expect((await screen.findByTestId('map')).textContent).toBe('2');
    } finally {
      if (any !== undefined) Object.defineProperty(AbortSignal, 'any', any);
    }
  });

  it('shows an error when the lookup throws unexpectedly', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      throw new TypeError('AbortSignal.timeout is not a function');
    });
    try {
      render(<App />);
      await search('a.eth');
      expect((await screen.findByRole('alert')).textContent).toBe(
        'Something went wrong',
      );
      expect(searchButton().getAttribute('aria-busy')).toBe('false');
      expect(screen.queryByTestId('map')).toBeNull();
    } finally {
      timeout.mockRestore();
    }
  });

  it('moves focus into the panel from the node list and back on close', async () => {
    const user = userEvent.setup();
    history.replaceState(null, '', '/?name=gloomy.eth');
    render(<App />);
    await screen.findByTestId('map');
    const list = screen.getByRole('navigation', { name: 'Names on the map' });
    const button = within(list).getByRole('button', { name: 'c1.gloomy.eth' });

    act(() => {
      button.focus();
    });
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 2, name: 'c1.gloomy.eth' }),
    );

    await user.keyboard('{Escape}');
    expect(
      screen.queryByRole('complementary', { name: 'Name details' }),
    ).toBeNull();
    expect(document.activeElement).toBe(button);

    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Close details' }));
    expect(document.activeElement).toBe(button);
  });

  it('marks the map area while the panel is open', async () => {
    history.replaceState(null, '', '/?name=gloomy.eth');
    render(<App />);
    await screen.findByTestId('map');
    const main = screen.getByRole('main');
    expect(main.classList.contains('app-main-details')).toBe(false);

    const list = screen.getByRole('navigation', { name: 'Names on the map' });
    fireEvent.click(
      within(list).getByRole('button', { name: 'c1.gloomy.eth' }),
    );
    expect(main.classList.contains('app-main-details')).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(main.classList.contains('app-main-details')).toBe(false);
  });
});
