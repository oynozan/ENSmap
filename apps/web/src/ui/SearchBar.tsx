import './SearchBar.css';

import { useId, type KeyboardEvent, type SubmitEvent } from 'react';

export function SearchBar(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (name: string) => void;
  busy: boolean;
  error: string | null;
}) {
  const { value, onChange, onSubmit, busy, error } = props;
  const errorId = useId();

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = value.trim();
    if (name !== '') {
      onSubmit(name);
    }
  }

  // A disabled default button blocks Enter, so a slow lookup can still be replaced
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (busy && event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <div className="search">
      <form role="search" className="search-bar" onSubmit={handleSubmit}>
        <input
          className="search-input"
          type="text"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search an ENS name"
          aria-label="ENS name"
          aria-describedby={error === null ? undefined : errorId}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          enterKeyHint="search"
        />
        <button
          className="search-button"
          type="submit"
          aria-label="Search"
          disabled={busy}
          aria-busy={busy}
        >
          <svg
            className="search-icon"
            viewBox="0 0 20 20"
            width="18"
            height="18"
            aria-hidden="true"
            focusable="false"
          >
            <circle
              cx="8.5"
              cy="8.5"
              r="5.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
            />
            <path
              d="M12.6 12.6 17 17"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </form>
      {error !== null && (
        <p id={errorId} className="search-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
