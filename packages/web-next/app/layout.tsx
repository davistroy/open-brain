import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Open Brain',
  description: 'Personal AI knowledge infrastructure',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
