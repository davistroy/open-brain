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
    ];
  },
};

export default nextConfig;
