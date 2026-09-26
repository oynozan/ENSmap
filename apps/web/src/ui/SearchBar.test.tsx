// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SearchBar } from './SearchBar.tsx';

afterEach(cleanup);

function Harness(props: {
  onSubmit: (name: string) => void;
  busy?: boolean;
  error?: string | null;
}) {
  const [value, setValue] = useState('');
  return (
    <SearchBar
      value={value}
      onChange={setValue}
      onSubmit={props.onSubmit}
      busy={props.busy ?? false}
      error={props.error ?? null}
    />
  );
}

function input(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('ENS name');
}

function button(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Search' });
}

describe('SearchBar', () => {
  it('renders the search form with the exact copy', () => {
    render(<Harness onSubmit={vi.fn()} />);
    expect(screen.getByRole('search')).toBeTruthy();
    expect(input().placeholder).toBe('Search an ENS name');
    expect(input().autocomplete).toBe('off');
    expect(input().getAttribute('spellcheck')).toBe('false');
    expect(input().getAttribute('autocapitalize')).toBe('none');
    expect(input().getAttribute('enterkeyhint')).toBe('search');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('submits the trimmed name on Enter', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSubmit={onSubmit} />);
    await user.type(input(), ' seller-a.eth{Enter}');
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('seller-a.eth');
  });

  it('submits on a click of the Search button', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSubmit={onSubmit} />);
    await user.type(input(), 'gloomy.eth ');
    await user.click(button());
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('gloomy.eth');
  });

  it('does not submit whitespace', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSubmit={onSubmit} />);
    await user.type(input(), '   {Enter}');
    await user.click(button());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disables the button while busy', () => {
    render(<Harness onSubmit={vi.fn()} busy />);
    expect(button().disabled).toBe(true);
    expect(button().getAttribute('aria-busy')).toBe('true');
  });

  it('still submits a new name on Enter while busy', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSubmit={onSubmit} busy />);
    await user.type(input(), 'b.eth{Enter}');
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('b.eth');
  });

  it('shows the error as an alert', () => {
    render(<Harness onSubmit={vi.fn()} error="x" />);
    expect(screen.getByRole('alert').textContent).toBe('x');
  });
});
