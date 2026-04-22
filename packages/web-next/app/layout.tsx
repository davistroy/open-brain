import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Open Brain',
  description: 'Personal AI knowledge infrastructure — self-hosted knowledge base and AI assistant',
  // PWA manifest — Next.js 16 writes <link rel="manifest"> from this field.
  manifest: '/manifest.json',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // book-cloth — matches manifest.json theme_color
  themeColor: '#4a3728',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-wash="parchment" suppressHydrationWarning>
      <head>
        {/*
          Anti-flash theme + wash script — executes synchronously before body renders.
          1. Reads localStorage('theme') and applies/removes the `dark` class.
          2. Reads localStorage('wash') and sets data-wash attribute.
          Both run before first paint to prevent visible flashes of the wrong theme/wash.
          Wrapped in try/catch so private-browsing localStorage errors are silent.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var d=document.documentElement;var t=localStorage.getItem('theme');if(t==='dark'||((!t||t==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches)){d.classList.add('dark');}else{d.classList.remove('dark');}var w=localStorage.getItem('wash');var validWash=['parchment','kraft','moss','peach'];if(w&&validWash.indexOf(w)!==-1){d.dataset.wash=w;}else{d.dataset.wash='parchment';}}catch(e){}})();`,
          }}
        />
      </head>
      <body className="font-body text-[14px] leading-[22px] antialiased bg-parchment">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
