import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Open Brain',
  description: 'Personal AI knowledge infrastructure — self-hosted knowledge base and AI assistant',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-wash="parchment">
      <body className="font-body text-[14px] leading-[22px] antialiased bg-parchment">
        {children}
      </body>
    </html>
  );
}
