import './NodeList.css';

import type { GraphNode } from '@ensmap/core/schema';

export function NodeList(props: {
  nodes: readonly GraphNode[];
  onFocusNode: (id: string | null) => void;
  onSelect: (id: string) => void;
}) {
  const { nodes, onFocusNode, onSelect } = props;
  return (
    <nav className="node-list" aria-label="Names on the map">
      <ul>
        {nodes.map((node) => (
          <li key={node.id}>
            <button
              type="button"
              onFocus={() => {
                onFocusNode(node.id);
              }}
              onBlur={() => {
                onFocusNode(null);
              }}
              onClick={() => {
                onSelect(node.id);
              }}
            >
              {node.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
