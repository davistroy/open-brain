import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  // Hard corners design system — no image optimization needed in M1
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_URL ?? 'http://localhost:3002'}/api/:path*`,
      },
      {
        // Voice-capture service proxy — keeps browser auth headers and multipart body intact.
        // VOICE_CAPTURE_URL defaults to localhost:3001 for local dev (same port as voice-capture).
        source: '/voice-api/:path*',
        destination: `${process.env.VOICE_CAPTURE_URL ?? 'http://localhost:3001'}/:path*`,
      },
    ];
  },
};

export default nextConfig;
