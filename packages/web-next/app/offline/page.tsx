'use client';

export default function OfflinePage() {
  return (
    <div className="min-h-screen bg-[#faf7f2] flex items-center justify-center px-6">
      <div className="text-center max-w-sm">
        {/* Book-cloth icon — simple SVG, no network dependency */}
        <div
          className="mx-auto mb-8 w-16 h-16 rounded-2xl flex items-center justify-center"
          style={{ backgroundColor: '#4a3728' }}
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 32 32"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M8 6h16a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"
              stroke="#faf7f2"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            <path
              d="M16 10v12M10 16h12"
              stroke="#faf7f2"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </div>

        <h1
          className="text-[22px] font-semibold leading-tight mb-3"
          style={{ color: '#4a3728' }}
        >
          You&apos;re offline
        </h1>

        <p className="text-[14px] leading-[22px] text-[#6b5a4e] mb-8">
          Reconnect to continue using Open Brain. Your data is safe — nothing is
          lost while you&apos;re disconnected.
        </p>

        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13px] font-medium text-[#faf7f2] transition-opacity hover:opacity-90 active:opacity-80"
          style={{ backgroundColor: '#4a3728' }}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
