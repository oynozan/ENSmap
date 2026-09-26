import './DetailsPanel.css';

import type { GraphNode } from '@ensmap/core/schema';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';

const COPIED_MS = 1500;

function walletStatus(node: GraphNode): string {
  if (node.address === undefined) {
    return 'no wallet';
  }
  if (node.verified === true && node.verifiedBy === 'primary-name') {
    return 'verified by primary name';
  }
  if (node.verified === true && node.verifiedBy === 'owner') {
    return 'verified by owner';
  }
  return 'unverified';
}

function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="details-row">
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

export function DetailsPanel(props: {
  node: GraphNode;
  nodesById: ReadonlyMap<string, GraphNode>;
  onSelect: (id: string) => void;
  onClose: () => void;
  ref?: Ref<HTMLElement>;
}) {
  const { node, nodesById, onSelect, onClose } = props;
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Hands focus back to the opener, a layout cleanup still sees focus inside the panel
  useLayoutEffect(() => {
    const opener = document.activeElement;
    const heading = headingRef.current;
    return () => {
      const inside = heading
        ?.closest('aside')
        ?.contains(document.activeElement);
      if (
        inside === true &&
        opener instanceof HTMLElement &&
        opener.isConnected
      ) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  // Focus follows a list or panel control to each name, a map click leaves it on the page
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active !== null && active !== document.body) {
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [node.id]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    if (copiedAddress === null) {
      return;
    }
    const timer = setTimeout(() => {
      setCopiedAddress(null);
    }, COPIED_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [copiedAddress]);

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedAddress(address);
    } catch {
      // Clipboard access is denied or unavailable, so the button keeps its label
    }
  }

  const address = node.address;
  const sameWallet = (node.names ?? []).filter((id) => id !== node.id);
  const sharedWith = node.sharedWith ?? [];

  return (
    <aside ref={props.ref} className="details" aria-label="Name details">
      <header className="details-head">
        <h2 ref={headingRef} className="details-title" tabIndex={-1}>
          {node.label}
        </h2>
        <button
          className="details-close"
          type="button"
          aria-label="Close details"
          onClick={onClose}
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>
      <p className="details-status">{walletStatus(node)}</p>
      <dl className="details-rows">
        {address !== undefined && (
          <Row label="Wallet">
            <span className="details-address">{address}</span>
            <button
              className="details-copy"
              type="button"
              onClick={() => {
                void copyAddress(address);
              }}
            >
              {copiedAddress === address ? 'Copied' : 'Copy'}
            </button>
          </Row>
        )}
        <Row label="Owner">
          {node.owner === undefined ? (
            '—'
          ) : (
            <span className="details-address">{node.owner}</span>
          )}
        </Row>
        {sameWallet.length > 0 && (
          <Row label="Same wallet">
            <ul className="details-list">
              {sameWallet.map((id) => (
                <li key={id}>
                  <button
                    className="details-link"
                    type="button"
                    onClick={() => {
                      // This button unmounts with the name it is listed under
                      headingRef.current?.focus({ preventScroll: true });
                      onSelect(id);
                    }}
                  >
                    {nodesById.get(id)?.label ?? id}
                  </button>
                </li>
              ))}
            </ul>
          </Row>
        )}
        {node.canonical !== undefined && (
          <Row label="Canonical">{node.canonical}</Row>
        )}
        {sharedWith.length > 0 && (
          <Row label="Registry shared with">
            <ul className="details-list">
              {sharedWith.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </Row>
        )}
        {node.tags.length > 0 && (
          <Row label="Tags">
            <ul className="details-list details-tags">
              {node.tags.map((tag) => (
                <li key={tag}>{tag}</li>
              ))}
            </ul>
          </Row>
        )}
      </dl>
    </aside>
  );
}
