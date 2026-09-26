import './App.css';

import type { Graph, GraphNode } from '@ensmap/core/schema';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchGraph, MESSAGES } from './api.ts';
import { MapView } from './map/MapView.tsx';
import { DetailsPanel } from './ui/DetailsPanel.tsx';
import { NodeList } from './ui/NodeList.tsx';
import { SearchBar } from './ui/SearchBar.tsx';
import { StatusLine } from './ui/StatusLine.tsx';
import { nameHref, readNameParam } from './url.ts';

const TITLE = 'ENSmap';

function currentHref(): string {
  return location.pathname + location.search;
}

export function App() {
  const [query, setQuery] = useState('');
  const [graph, setGraph] = useState<Graph | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const searchRef = useRef<AbortController | null>(null);

  const showGraph = useCallback((next: Graph | null) => {
    setGraph(next);
    setSelectedId(null);
    setFocusedId(null);
  }, []);

  const search = useCallback(
    async (name: string) => {
      searchRef.current?.abort();
      const controller = new AbortController();
      searchRef.current = controller;
      setBusy(true);
      setError(null);
      try {
        const result = await fetchGraph(name, { signal: controller.signal });
        // A newer search, or a Back to no name, replaced this one
        if (searchRef.current !== controller) return;
        if (result.ok) {
          showGraph(result.graph);
        } else {
          showGraph(null);
          setError(result.message);
        }
      } catch {
        // An abort means a newer search or a Back replaced this one
        if (controller.signal.aborted) return;
        showGraph(null);
        setError(MESSAGES.generic);
      } finally {
        if (searchRef.current === controller) {
          searchRef.current = null;
          setBusy(false);
        }
      }
    },
    [showGraph],
  );

  // Mount and Back/Forward both follow ?name=
  useEffect(() => {
    function followUrl() {
      const name = readNameParam(location.search);
      setQuery(name ?? '');
      if (name !== null) {
        void search(name);
        return;
      }
      searchRef.current?.abort();
      searchRef.current = null;
      setBusy(false);
      setError(null);
      showGraph(null);
    }
    followUrl();
    window.addEventListener('popstate', followUrl);
    return () => {
      window.removeEventListener('popstate', followUrl);
      searchRef.current?.abort();
      searchRef.current = null;
    };
  }, [search, showGraph]);

  useEffect(() => {
    const root = graph?.nodes[0]?.label;
    document.title = root === undefined ? TITLE : `${root} · ${TITLE}`;
  }, [graph]);

  function submit(name: string) {
    if (readNameParam(location.search) !== name) {
      history.pushState(null, '', nameHref(name, currentHref()));
    }
    void search(name);
  }

  const closeDetails = useCallback(() => {
    setSelectedId(null);
  }, []);

  const nodesById = useMemo(
    (): ReadonlyMap<string, GraphNode> =>
      new Map(graph?.nodes.map((node) => [node.id, node])),
    [graph],
  );
  const selected = selectedId === null ? undefined : nodesById.get(selectedId);

  return (
    <div className="app">
      <header className="app-header">
        <SearchBar
          value={query}
          onChange={setQuery}
          onSubmit={submit}
          busy={busy}
          error={error}
        />
      </header>
      <main className="app-main">
        {graph === null ? (
          !busy && (
            <p className="app-empty">Search a name on the Sepolia ENSv2 Beta</p>
          )
        ) : (
          <>
            <MapView
              graph={graph}
              selectedId={selectedId}
              focusedId={focusedId}
              onSelect={setSelectedId}
            />
            <NodeList
              nodes={graph.nodes}
              onFocusNode={setFocusedId}
              onSelect={setSelectedId}
            />
            <StatusLine meta={graph.meta} />
          </>
        )}
        {selected !== undefined && (
          <DetailsPanel
            node={selected}
            nodesById={nodesById}
            onSelect={setSelectedId}
            onClose={closeDetails}
          />
        )}
      </main>
    </div>
  );
}
