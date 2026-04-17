import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FinancialPulseCard } from '../FinancialPulseCard';

// Mock the api module
vi.mock('@/lib/api', () => ({
  capturesApi: {
    list: vi.fn(),
  },
}));

import { capturesApi } from '@/lib/api';

describe('FinancialPulseCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders empty state when there is no financial activity', async () => {
    (capturesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      total: 0,
      limit: 400,
      offset: 0,
    });

    render(
      <MemoryRouter>
        <FinancialPulseCard />
      </MemoryRouter>,
    );

    // Wait for effect to resolve and render empty state
    await waitFor(() => {
      expect(
        screen.getByText(/No financial activity in the last 30 days/i),
      ).toBeInTheDocument();
    });

    expect(screen.getByText(/Ingest a CSV/i)).toBeInTheDocument();
    expect(capturesApi.list).toHaveBeenCalledWith({
      brain_view: 'personal',
      capture_type: 'observation',
      limit: 400,
    });
  });
});
