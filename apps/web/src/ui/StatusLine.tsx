import './StatusLine.css';

import type { GraphMeta } from '@ensmap/core/schema';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function StatusLine(props: { meta: GraphMeta }) {
  const { totals, truncated, warnings, namespace } = props.meta;
  const indexed = totals.indexed.exact
    ? `${totals.indexed.value}`
    : `≥${totals.indexed.value}`;
  const parts = [
    plural(totals.names, 'name'),
    `indexed ${indexed}`,
    namespace,
    ...(truncated.includes('names') ? ['truncated'] : []),
  ];

  return (
    <div className="status-line">
      <p className="status-text">{parts.join(' · ')}</p>
      {warnings.length > 0 && (
        <details className="status-warnings">
          <summary>{plural(warnings.length, 'warning')}</summary>
          <ul>
            {warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
