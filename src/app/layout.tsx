import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sift — Research Assistant with Temporal Memory',
  description:
    'Sift connects your prior conversations with live web evidence, searches when freshness matters, and clearly verifies what has changed.',
  icons: {
    icon: [
      { url: '/sift-favicon.png', type: 'image/png' },
      { url: '/favicon.ico' },
    ],
    shortcut: '/sift-favicon.png',
    apple: '/sift-favicon.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/sift-favicon.png" type="image/png" />
      </head>
      <body className="bg-[#fbfbfb] text-[#111] antialiased">
        {children}
      </body>
    </html>
  );
}
